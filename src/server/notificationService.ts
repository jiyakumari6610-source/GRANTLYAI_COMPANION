import { getApps } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };
import { deriveApplicationNotifications, evaluateTrackedApplication } from '../lib/applicationTrackerEngine.ts';
import {
  buildApplicationWorkflowNotification,
  buildDocumentProcessingNotification,
  buildReadinessNotification,
  buildTrustGuardAlertNotification,
  doesProfileMatchAnnouncementAudience,
  evaluateFullStudentNotifications,
  isAnnouncementActiveAt,
  normalizeNotificationPreferences,
  sanitizeDeadlineIntervals,
} from '../lib/notificationEngine.ts';
import type { ReadinessEvaluationReport } from '../lib/readinessEngine.ts';
import { sanitizeInternalRoute } from '../lib/securityUtils.ts';
import { buildAuditLogRecord, recordAuditLogRest } from './adminService.ts';
import { CompanionError, fetchLiveScholarshipsFromDb, resolveStudentDatabaseSnapshot } from './companionContext.ts';
import type {
  AdminAnnouncementRecord,
  AnnouncementAudience,
  ApplicationRecord,
  DocumentProcessingStatus,
  NotificationDeliveryLogRecord,
  NotificationPreferenceRecord,
  NotificationRecord,
  ReadinessAssessment,
  SavedScholarship,
  ScheduledNotificationRunRecord,
  Scholarship,
  StudentProfile,
  TrustGuardDocumentAssessment,
} from '../types/database.ts';

type FirestoreValue = {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  timestampValue?: string;
  stringValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};

function encodeFirestoreValue(val: unknown): FirestoreValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.filter((item) => item !== undefined).map((item) => encodeFirestoreValue(item)),
      },
    };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = encodeFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function encodeFirestoreFields(obj: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      fields[k] = encodeFirestoreValue(v);
    }
  }
  return fields;
}

function decodeFirestoreValue(val: FirestoreValue | undefined): unknown {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) {
    const num = Number(val.integerValue);
    return Number.isFinite(num) ? num : val.integerValue;
  }
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('timestampValue' in val) return val.timestampValue;
  if ('stringValue' in val) return val.stringValue;
  if ('arrayValue' in val) {
    return (val.arrayValue?.values ?? []).map((item) => decodeFirestoreValue(item));
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue?.fields ?? {})) {
      out[k] = decodeFirestoreValue(v);
    }
    return out;
  }
  return null;
}

function decodeFirestoreDocument<T>(fields: Record<string, FirestoreValue> | undefined): T | null {
  if (!fields) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = decodeFirestoreValue(v);
  }
  return out as T;
}

function docUrl(collectionPath: string, docId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/${collectionPath}/${encodeURIComponent(docId)}`;
}

async function getDocRest<T>(
  collectionPath: string,
  docId: string,
  idToken: string
): Promise<{ status: number; data: T | null }> {
  const res = await fetch(docUrl(collectionPath, docId), {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) return { status: res.status, data: null };
  const json = (await res.json()) as { fields?: Record<string, FirestoreValue> };
  return { status: 200, data: decodeFirestoreDocument<T>(json.fields) };
}

async function setDocRest(
  collectionPath: string,
  docId: string,
  payload: Record<string, unknown>,
  idToken: string
): Promise<void> {
  const res = await fetch(docUrl(collectionPath, docId), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ fields: encodeFirestoreFields(payload) }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new CompanionError(
      res.status === 403 ? 403 : 502,
      res.status === 403 ? 'FIRESTORE_PERMISSION_DENIED' : 'FIRESTORE_WRITE_FAILED',
      `Failed to persist ${collectionPath}/${docId} (${res.status}): ${errText.slice(0, 200)}`
    );
  }
}

async function deleteDocRest(
  collectionPath: string,
  docId: string,
  idToken: string
): Promise<void> {
  const res = await fetch(docUrl(collectionPath, docId), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok && res.status !== 404) {
    throw new CompanionError(
      res.status === 403 ? 403 : 502,
      'FIRESTORE_DELETE_FAILED',
      `Failed to delete ${collectionPath}/${docId} (${res.status})`
    );
  }
}

async function listCollectionRest<T>(
  collectionId: string,
  idToken: string,
  pageSize = 300
): Promise<T[]> {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/${collectionId}?pageSize=${pageSize}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new CompanionError(403, 'FIRESTORE_PERMISSION_DENIED', `Permission denied reading ${collectionId}.`);
    }
    return [];
  }
  const json = (await res.json()) as {
    documents?: Array<{ fields?: Record<string, FirestoreValue> }>;
  };
  const items: T[] = [];
  for (const d of json.documents ?? []) {
    const decoded = decodeFirestoreDocument<T>(d.fields);
    if (decoded) items.push(decoded);
  }
  return items;
}

async function queryByFieldRest<T>(
  collectionId: string,
  fieldPath: string,
  stringValue: string,
  idToken: string,
  limit = 200
): Promise<T[]> {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath },
            op: 'EQUAL',
            value: { stringValue },
          },
        },
        limit,
      },
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{ document?: { fields?: Record<string, FirestoreValue> } }>;
  const items: T[] = [];
  for (const row of rows) {
    const decoded = decodeFirestoreDocument<T>(row.document?.fields);
    if (decoded) items.push(decoded);
  }
  return items;
}

export function makeNotifServiceId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// Module 6: Real Email Delivery Provider & Idempotent Logging
// ============================================================================

export interface EmailProviderConfig {
  configured: boolean;
  provider: 'resend' | 'sendgrid' | 'webhook' | 'unconfigured';
  statusLabel: string;
  fromEmail: string;
}

export function getServerEmailProviderConfig(
  env: NodeJS.ProcessEnv = process.env
): EmailProviderConfig {
  const fromEmail = (env.NOTIFICATION_FROM_EMAIL || 'alerts@grantly.ai').trim();

  if (env.RESEND_API_KEY && env.RESEND_API_KEY.trim().length > 5) {
    return {
      configured: true,
      provider: 'resend',
      statusLabel: 'Configured (Resend)',
      fromEmail,
    };
  }
  if (env.SENDGRID_API_KEY && env.SENDGRID_API_KEY.trim().length > 5) {
    return {
      configured: true,
      provider: 'sendgrid',
      statusLabel: 'Configured (SendGrid)',
      fromEmail,
    };
  }
  if (env.EMAIL_WEBHOOK_URL && env.EMAIL_WEBHOOK_URL.trim().startsWith('http')) {
    return {
      configured: true,
      provider: 'webhook',
      statusLabel: 'Configured (Transactional Email Webhook)',
      fromEmail,
    };
  }

  return {
    configured: false,
    provider: 'unconfigured',
    statusLabel: 'Not Configured (Requires SMTP/Email Provider)',
    fromEmail,
  };
}

export type EmailFetchFn = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<globalThis.Response>;

export async function dispatchNotificationEmailWithRetries(params: {
  userId: string;
  recipientEmail?: string;
  notification: NotificationRecord;
  existingLogs?: NotificationDeliveryLogRecord[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: EmailFetchFn;
  maxRetries?: number;
}): Promise<NotificationDeliveryLogRecord> {
  const {
    userId,
    recipientEmail,
    notification,
    existingLogs = [],
    env = process.env,
    fetchImpl = globalThis.fetch,
    maxRetries = 2,
  } = params;

  const nowIso = new Date().toISOString();
  const idempotencyKey = `email-${userId}-${notification.dedupeKey || notification.id}`;

  const alreadyDelivered = existingLogs.find(
    (l) =>
      l.idempotencyKey === idempotencyKey &&
      (l.status === 'Sent' || l.status === 'Delivered')
  );
  if (alreadyDelivered) {
    return alreadyDelivered;
  }

  const config = getServerEmailProviderConfig(env);
  if (!config.configured) {
    return {
      id: makeNotifServiceId('dlog'),
      userId,
      notificationId: notification.id,
      ...(recipientEmail ? { recipientEmail } : {}),
      channel: 'email',
      provider: 'unconfigured',
      idempotencyKey,
      status: 'Not Configured',
      attempts: 0,
      errorMessage:
        'No server email provider (RESEND_API_KEY, SENDGRID_API_KEY, or EMAIL_WEBHOOK_URL) is configured. Notification delivered in-app only.',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  if (!recipientEmail || !recipientEmail.includes('@')) {
    return {
      id: makeNotifServiceId('dlog'),
      userId,
      notificationId: notification.id,
      channel: 'email',
      provider: config.provider,
      idempotencyKey,
      status: 'Failed',
      attempts: 0,
      errorMessage: 'Student account does not have a valid verified email address.',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  let attempts = 0;
  let lastHttpStatus: number | undefined;
  let lastError: string | undefined;
  let providerMessageId: string | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attempts = attempt;
    try {
      let response: globalThis.Response;
      const subject = `[GRANTLY AI] ${notification.title}`;
      const textBody = `${notification.message}\n\n${
        notification.officialSourceUrl ? `Official Source: ${notification.officialSourceUrl}\n` : ''
      }${notification.verifiedDeadline ? `Verified Deadline: ${notification.verifiedDeadline}\n` : ''}Open GRANTLY AI to review details.`;

      if (config.provider === 'resend') {
        response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            from: config.fromEmail,
            to: [recipientEmail],
            subject,
            text: textBody,
          }),
          signal: AbortSignal.timeout(7000),
        });
        lastHttpStatus = response.status;
        if (response.ok) {
          const json = (await response.json().catch(() => ({}))) as { id?: string };
          providerMessageId = json.id;
          return {
            id: makeNotifServiceId('dlog'),
            userId,
            notificationId: notification.id,
            recipientEmail,
            channel: 'email',
            provider: 'resend',
            idempotencyKey,
            status: 'Sent',
            attempts,
            httpStatus: response.status,
            ...(providerMessageId ? { providerMessageId } : {}),
            createdAt: nowIso,
            updatedAt: new Date().toISOString(),
          };
        }
      } else if (config.provider === 'sendgrid') {
        response = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: recipientEmail }] }],
            from: { email: config.fromEmail },
            subject,
            content: [{ type: 'text/plain', value: textBody }],
          }),
          signal: AbortSignal.timeout(7000),
        });
        lastHttpStatus = response.status;
        if (response.ok) {
          providerMessageId = response.headers.get('x-message-id') || undefined;
          return {
            id: makeNotifServiceId('dlog'),
            userId,
            notificationId: notification.id,
            recipientEmail,
            channel: 'email',
            provider: 'sendgrid',
            idempotencyKey,
            status: 'Sent',
            attempts,
            httpStatus: response.status,
            ...(providerMessageId ? { providerMessageId } : {}),
            createdAt: nowIso,
            updatedAt: new Date().toISOString(),
          };
        }
      } else {
        response = await fetchImpl(env.EMAIL_WEBHOOK_URL!, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(env.EMAIL_WEBHOOK_SECRET
              ? { 'X-Webhook-Secret': env.EMAIL_WEBHOOK_SECRET }
              : {}),
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            to: recipientEmail,
            from: config.fromEmail,
            subject,
            text: textBody,
            notificationId: notification.id,
            category: notification.category,
          }),
          signal: AbortSignal.timeout(7000),
        });
        lastHttpStatus = response.status;
        if (response.ok) {
          const json = (await response.json().catch(() => ({}))) as { messageId?: string; id?: string };
          providerMessageId = json.messageId || json.id;
          return {
            id: makeNotifServiceId('dlog'),
            userId,
            notificationId: notification.id,
            recipientEmail,
            channel: 'email',
            provider: 'webhook',
            idempotencyKey,
            status: 'Sent',
            attempts,
            httpStatus: response.status,
            ...(providerMessageId ? { providerMessageId } : {}),
            createdAt: nowIso,
            updatedAt: new Date().toISOString(),
          };
        }
      }

      const bodyErr = await response.text().catch(() => '');
      lastError = `Provider HTTP ${response.status}: ${bodyErr.slice(0, 240)}`;
      // Do not retry 4xx client errors except 429
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 240) : 'Network failure sending email.';
    }
  }

  return {
    id: makeNotifServiceId('dlog'),
    userId,
    notificationId: notification.id,
    recipientEmail,
    channel: 'email',
    provider: config.provider,
    idempotencyKey,
    status: 'Failed',
    attempts,
    ...(lastHttpStatus ? { httpStatus: lastHttpStatus } : {}),
    errorMessage: lastError || 'Email delivery failed after retries.',
    createdAt: nowIso,
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Notification Preferences & Feed Persistence (Student-Isolated)
// ============================================================================

export async function getAndNormalizePreferencesServer(params: {
  uid: string;
  idToken: string;
}): Promise<NotificationPreferenceRecord> {
  const emailConfig = getServerEmailProviderConfig();
  const res = await getDocRest<NotificationPreferenceRecord>(
    'notification_preferences',
    params.uid,
    params.idToken
  );
  return normalizeNotificationPreferences(params.uid, res.data, emailConfig.statusLabel);
}

export async function savePreferencesServer(params: {
  uid: string;
  idToken: string;
  input: Partial<NotificationPreferenceRecord>;
}): Promise<NotificationPreferenceRecord> {
  const emailConfig = getServerEmailProviderConfig();
  const existing = await getAndNormalizePreferencesServer({
    uid: params.uid,
    idToken: params.idToken,
  });

  const merged = normalizeNotificationPreferences(
    params.uid,
    {
      ...existing,
      ...params.input,
      deadlineIntervalsDays:
        params.input.deadlineIntervalsDays !== undefined
          ? sanitizeDeadlineIntervals(params.input.deadlineIntervalsDays)
          : existing.deadlineIntervalsDays,
      updatedAt: new Date().toISOString(),
    },
    emailConfig.statusLabel
  );

  await setDocRest(
    'notification_preferences',
    params.uid,
    merged as unknown as Record<string, unknown>,
    params.idToken
  );
  return merged;
}

export async function persistNotificationsForUserServer(params: {
  uid: string;
  idToken: string;
  recipientEmail?: string;
  drafts: NotificationRecord[];
  preferences: NotificationPreferenceRecord;
}): Promise<{
  persisted: NotificationRecord[];
  deliveryLogs: NotificationDeliveryLogRecord[];
}> {
  const { uid, idToken, recipientEmail, drafts, preferences } = params;
  if (drafts.length === 0) {
    return { persisted: [], deliveryLogs: [] };
  }

  const [existingNotifs, existingLogs] = await Promise.all([
    queryByFieldRest<NotificationRecord>('notifications', 'userId', uid, idToken, 300),
    queryByFieldRest<NotificationDeliveryLogRecord>('notification_delivery_logs', 'userId', uid, idToken, 200),
  ]);

  const seenKeys = new Set(
    existingNotifs.map((n) => n.dedupeKey).filter((k): k is string => Boolean(k))
  );

  const emailConfig = getServerEmailProviderConfig();
  const persisted: NotificationRecord[] = [];
  const deliveryLogs: NotificationDeliveryLogRecord[] = [];

  for (const draft of drafts) {
    if (draft.dedupeKey && seenKeys.has(draft.dedupeKey)) {
      continue;
    }
    if (draft.dedupeKey) seenKeys.add(draft.dedupeKey);

    let finalRecord = { ...draft };

    // Attempt email delivery only when student opted in and priority is High/Medium (or urgent)
    if (preferences.emailNotificationsEnabled) {
      const log = await dispatchNotificationEmailWithRetries({
        userId: uid,
        recipientEmail,
        notification: finalRecord,
        existingLogs,
      });
      deliveryLogs.push(log);
      await setDocRest(
        'notification_delivery_logs',
        log.id,
        log as unknown as Record<string, unknown>,
        idToken
      );

      finalRecord = {
        ...finalRecord,
        deliveryChannel: emailConfig.configured ? 'in-app+email' : 'in-app',
        deliveryStatus:
          log.status === 'Sent' || log.status === 'Delivered'
            ? 'Email Sent'
            : log.status === 'Not Configured'
              ? 'Email Not Configured'
              : 'Email Failed',
      };
    }

    await setDocRest(
      'notifications',
      finalRecord.id,
      finalRecord as unknown as Record<string, unknown>,
      idToken
    );
    persisted.push(finalRecord);
  }

  return { persisted, deliveryLogs };
}

export async function syncStudentNotificationsServer(params: {
  uid: string;
  idToken: string;
  recipientEmail?: string;
  referenceDate?: Date;
}): Promise<{
  newNotifications: NotificationRecord[];
  allNotifications: NotificationRecord[];
  preferences: NotificationPreferenceRecord;
  emptyScholarshipDatabase: boolean;
  emailConfigured: boolean;
}> {
  const { uid, idToken, recipientEmail, referenceDate = new Date() } = params;
  const emailConfig = getServerEmailProviderConfig();

  const [scholarships, snapshot, preferences, publishedAnnouncements] = await Promise.all([
    fetchLiveScholarshipsFromDb(),
    resolveStudentDatabaseSnapshot(uid, idToken, {}),
    getAndNormalizePreferencesServer({ uid, idToken }),
    listCollectionRest<AdminAnnouncementRecord>('announcements', idToken, 100).catch(() => []),
  ]);

  const activeAnnouncements = publishedAnnouncements.filter((a) =>
    isAnnouncementActiveAt(a, referenceDate)
  );

  // Full Phase 10 evaluation (Smart Matches + Deadline Intelligence + Announcements)
  const fullEval = evaluateFullStudentNotifications({
    userId: uid,
    profile: snapshot.profile,
    scholarships,
    applications: snapshot.applications,
    savedScholarships: snapshot.savedScholarships,
    eligibilityAssessments: snapshot.eligibilityAssessments,
    documents: snapshot.documents,
    documentAnalyses: snapshot.documentAnalyses,
    announcements: activeAnnouncements,
    existingNotifications: snapshot.notifications,
    preferences,
    emailConfigured: emailConfig.configured,
    referenceDate,
  });

  // Also include Phase 8 application-level missing docs / TrustGuard / correction checks
  const schMap = new Map(scholarships.map((s) => [s.id, s]));
  const latestTg = snapshot.trustGuardAssessments?.[0] ?? null;
  const evaluatedApps = snapshot.applications.map((appItem) =>
    evaluateTrackedApplication({
      application: appItem,
      scholarship: schMap.get(appItem.scholarshipId) ?? null,
      profile: snapshot.profile,
      documents: snapshot.documents,
      documentAnalyses: snapshot.documentAnalyses,
      trustGuardAssessment: latestTg,
      savedChecklistItems: snapshot.applicationChecklistItems ?? [],
      referenceDate,
    })
  );

  const appAlerts = deriveApplicationNotifications({
    userId: uid,
    evaluatedApps,
    existingNotifications: [...snapshot.notifications, ...fullEval.newNotifications],
    preferences,
    nowIso: referenceDate.toISOString(),
  });

  const combinedDrafts = [...fullEval.newNotifications, ...appAlerts];
  const { persisted } = await persistNotificationsForUserServer({
    uid,
    idToken,
    recipientEmail: recipientEmail || snapshot.profile?.email,
    drafts: combinedDrafts,
    preferences,
  });

  const allNotifications = [...persisted, ...snapshot.notifications].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );

  return {
    newNotifications: persisted,
    allNotifications,
    preferences,
    emptyScholarshipDatabase: fullEval.emptyScholarshipDatabase,
    emailConfigured: emailConfig.configured,
  };
}

// ============================================================================
// Non-blocking Integration Hooks for Existing Platform Modules
// ============================================================================

export async function emitDocumentEventNotificationSafe(params: {
  uid: string;
  idToken: string;
  recipientEmail?: string;
  documentId: string;
  fileName: string;
  documentType: string;
  processingStatus: DocumentProcessingStatus;
  errorDetails?: string;
}): Promise<NotificationRecord | null> {
  try {
    const emailConfig = getServerEmailProviderConfig();
    const preferences = await getAndNormalizePreferencesServer({
      uid: params.uid,
      idToken: params.idToken,
    });
    const draft = buildDocumentProcessingNotification({
      userId: params.uid,
      documentId: params.documentId,
      fileName: params.fileName,
      documentType: params.documentType,
      processingStatus: params.processingStatus,
      errorDetails: params.errorDetails,
      preferences,
      emailConfigured: emailConfig.configured,
    });
    if (!draft) return null;
    const res = await persistNotificationsForUserServer({
      uid: params.uid,
      idToken: params.idToken,
      recipientEmail: params.recipientEmail,
      drafts: [draft],
      preferences,
    });
    return res.persisted[0] ?? null;
  } catch (err) {
    console.warn('Non-blocking document notification emission skipped:', err);
    return null;
  }
}

export async function emitReadinessEventNotificationSafe(params: {
  uid: string;
  idToken: string;
  recipientEmail?: string;
  report: ReadinessEvaluationReport;
  previousAssessment?: ReadinessAssessment | null;
  aiPlanUpdated?: boolean;
}): Promise<NotificationRecord | null> {
  try {
    const emailConfig = getServerEmailProviderConfig();
    const preferences = await getAndNormalizePreferencesServer({
      uid: params.uid,
      idToken: params.idToken,
    });
    const draft = buildReadinessNotification({
      userId: params.uid,
      report: params.report,
      previousAssessment: params.previousAssessment,
      aiPlanUpdated: params.aiPlanUpdated,
      preferences,
      emailConfigured: emailConfig.configured,
    });
    if (!draft) return null;
    const res = await persistNotificationsForUserServer({
      uid: params.uid,
      idToken: params.idToken,
      recipientEmail: params.recipientEmail,
      drafts: [draft],
      preferences,
    });
    return res.persisted[0] ?? null;
  } catch (err) {
    console.warn('Non-blocking readiness notification emission skipped:', err);
    return null;
  }
}

export async function emitTrustGuardEventNotificationSafe(params: {
  uid: string;
  idToken: string;
  recipientEmail?: string;
  assessment: Pick<
    TrustGuardDocumentAssessment,
    'dataFingerprint' | 'overallVerificationStatus' | 'severityCounts' | 'findings'
  >;
}): Promise<NotificationRecord | null> {
  try {
    const emailConfig = getServerEmailProviderConfig();
    const preferences = await getAndNormalizePreferencesServer({
      uid: params.uid,
      idToken: params.idToken,
    });
    const draft = buildTrustGuardAlertNotification({
      userId: params.uid,
      assessment: params.assessment,
      preferences,
      emailConfigured: emailConfig.configured,
    });
    if (!draft) return null;
    const res = await persistNotificationsForUserServer({
      uid: params.uid,
      idToken: params.idToken,
      recipientEmail: params.recipientEmail,
      drafts: [draft],
      preferences,
    });
    return res.persisted[0] ?? null;
  } catch (err) {
    console.warn('Non-blocking TrustGuard notification emission skipped:', err);
    return null;
  }
}

export async function emitApplicationEventNotificationSafe(params: {
  uid: string;
  idToken: string;
  recipientEmail?: string;
  application: ApplicationRecord;
  previousStatus?: string;
}): Promise<NotificationRecord | null> {
  try {
    const emailConfig = getServerEmailProviderConfig();
    const preferences = await getAndNormalizePreferencesServer({
      uid: params.uid,
      idToken: params.idToken,
    });
    const draft = buildApplicationWorkflowNotification({
      userId: params.uid,
      application: params.application,
      previousStatus: params.previousStatus,
      preferences,
      emailConfigured: emailConfig.configured,
    });
    if (!draft) return null;
    const res = await persistNotificationsForUserServer({
      uid: params.uid,
      idToken: params.idToken,
      recipientEmail: params.recipientEmail,
      drafts: [draft],
      preferences,
    });
    return res.persisted[0] ?? null;
  } catch (err) {
    console.warn('Non-blocking application notification emission skipped:', err);
    return null;
  }
}

// ============================================================================
// Notification CRUD (Read / Archive / Delete / Delivery Logs)
// ============================================================================

export async function updateNotificationStateServer(params: {
  uid: string;
  idToken: string;
  notificationId: string;
  action: 'mark_read' | 'mark_unread' | 'archive' | 'unarchive' | 'delete';
}): Promise<{ success: true }> {
  const { uid, idToken, notificationId, action } = params;
  const existing = await getDocRest<NotificationRecord>('notifications', notificationId, idToken);
  if (!existing.data) {
    throw new CompanionError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.');
  }
  if (existing.data.userId !== uid) {
    throw new CompanionError(403, 'CROSS_STUDENT_FORBIDDEN', 'You cannot modify another student\'s notification.');
  }

  if (action === 'delete') {
    await deleteDocRest('notifications', notificationId, idToken);
    return { success: true };
  }

  const nowIso = new Date().toISOString();
  const updated: NotificationRecord = {
    ...existing.data,
    ...(action === 'mark_read' ? { isRead: true, readAt: nowIso } : {}),
    ...(action === 'mark_unread' ? { isRead: false } : {}),
    ...(action === 'archive' ? { isArchived: true, archivedAt: nowIso, isRead: true, readAt: existing.data.readAt || nowIso } : {}),
    ...(action === 'unarchive' ? { isArchived: false } : {}),
  };
  if (action === 'mark_unread') {
    delete updated.readAt;
  }
  if (action === 'unarchive') {
    delete updated.archivedAt;
  }

  await setDocRest(
    'notifications',
    notificationId,
    updated as unknown as Record<string, unknown>,
    idToken
  );
  return { success: true };
}

export async function listDeliveryLogsForUserServer(params: {
  uid: string;
  idToken: string;
}): Promise<NotificationDeliveryLogRecord[]> {
  const logs = await queryByFieldRest<NotificationDeliveryLogRecord>(
    'notification_delivery_logs',
    'userId',
    params.uid,
    params.idToken,
    100
  );
  return logs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ============================================================================
// Module 7: Admin Announcements Governance & Audience Delivery
// ============================================================================

export async function listAnnouncementsAdminServer(params: { idToken: string }) {
  const [items, profiles, runs] = await Promise.all([
    listCollectionRest<AdminAnnouncementRecord>('announcements', params.idToken, 200),
    listCollectionRest<StudentProfile>('profiles', params.idToken, 300),
    listCollectionRest<ScheduledNotificationRunRecord>('notification_runs', params.idToken, 50).catch(
      () => []
    ),
  ]);

  const emailConfig = getServerEmailProviderConfig();

  return {
    announcements: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    totalStudentsCount: profiles.length,
    scheduledRuns: runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    emailProvider: emailConfig,
  };
}

export async function upsertAnnouncementAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
  input: {
    id?: string;
    title: string;
    message: string;
    category: AdminAnnouncementRecord['category'];
    targetAudience: AnnouncementAudience;
    targetStates?: string[];
    targetEducationLevels?: string[];
    status: AdminAnnouncementRecord['status'];
    publishAt?: string;
    expiresAt?: string;
    actionRoute?: string;
  };
}) {
  const { adminUid, adminEmail, adminRole, idToken, input } = params;
  const nowIso = new Date().toISOString();

  const existing = input.id
    ? await getDocRest<AdminAnnouncementRecord>('announcements', input.id, idToken)
    : { status: 404, data: null };

  const id = existing.data?.id || input.id || makeNotifServiceId('ann');
  const record: AdminAnnouncementRecord = {
    id,
    title: input.title.trim().slice(0, 195),
    message: input.message.trim().slice(0, 1190),
    category: input.category,
    targetAudience: input.targetAudience,
    ...(input.targetStates && input.targetStates.length > 0
      ? { targetStates: input.targetStates }
      : {}),
    ...(input.targetEducationLevels && input.targetEducationLevels.length > 0
      ? { targetEducationLevels: input.targetEducationLevels }
      : {}),
    status: input.status,
    ...(input.publishAt ? { publishAt: input.publishAt } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.actionRoute ? { actionRoute: sanitizeInternalRoute(input.actionRoute, '/notifications') } : {}),
    deliveredCount: existing.data?.deliveredCount ?? 0,
    createdByUid: existing.data?.createdByUid || adminUid,
    createdByEmail: existing.data?.createdByEmail || adminEmail,
    ...(input.status === 'Published'
      ? {
          publishedByUid: adminUid,
          publishedAt: existing.data?.publishedAt || nowIso,
        }
      : existing.data?.publishedByUid
        ? {
            publishedByUid: existing.data.publishedByUid,
            publishedAt: existing.data.publishedAt,
          }
        : {}),
    createdAt: existing.data?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  await setDocRest('announcements', id, record as unknown as Record<string, unknown>, idToken);

  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: existing.data ? 'Announcement Updated' : 'Announcement Created',
    entityType: 'announcement',
    entityId: id,
    summary: `${existing.data ? 'Updated' : 'Created'} announcement "${record.title}" (${record.status}, audience: ${record.targetAudience}).`,
    nowIso,
  });
  await recordAuditLogRest(auditLog, idToken);

  let deliveredCount = record.deliveredCount ?? 0;
  if (record.status === 'Published' && isAnnouncementActiveAt(record)) {
    deliveredCount = await deliverAnnouncementToTargetStudentsServer({
      announcement: record,
      idToken,
    });
    if (deliveredCount > (record.deliveredCount ?? 0)) {
      record.deliveredCount = deliveredCount;
      await setDocRest('announcements', id, record as unknown as Record<string, unknown>, idToken);
    }
  }

  return { announcement: record, auditLog, deliveredCount };
}

export async function deliverAnnouncementToTargetStudentsServer(params: {
  announcement: AdminAnnouncementRecord;
  idToken: string;
}): Promise<number> {
  const { announcement, idToken } = params;
  if (!isAnnouncementActiveAt(announcement)) return 0;

  const [profiles, existingNotifs, prefsList] = await Promise.all([
    listCollectionRest<StudentProfile>('profiles', idToken, 400),
    listCollectionRest<NotificationRecord>('notifications', idToken, 500),
    listCollectionRest<NotificationPreferenceRecord>('notification_preferences', idToken, 400),
  ]);

  const prefMap = new Map(prefsList.map((p) => [p.uid, p]));
  const emailConfig = getServerEmailProviderConfig();
  const dedupeKey = `announcement-${announcement.id}`;
  const alreadyNotifiedUids = new Set(
    existingNotifs.filter((n) => n.dedupeKey === dedupeKey).map((n) => n.userId)
  );

  const nowIso = new Date().toISOString();
  let delivered = alreadyNotifiedUids.size;

  for (const profile of profiles) {
    if (alreadyNotifiedUids.has(profile.uid)) continue;
    if (!doesProfileMatchAnnouncementAudience(announcement, profile)) continue;

    const pref = normalizeNotificationPreferences(
      profile.uid,
      prefMap.get(profile.uid),
      emailConfig.statusLabel
    );
    if (announcement.category !== 'Maintenance' && pref.accountSecurityAlertsEnabled === false) {
      continue;
    }

    const notifId = `notif-ann-${announcement.id.slice(0, 36)}-${profile.uid.slice(0, 24)}`;
    const notif: NotificationRecord = {
      id: notifId,
      userId: profile.uid,
      title: announcement.title,
      message: announcement.message.slice(0, 595),
      category:
        announcement.category === 'Scholarship' || announcement.category === 'Deadline'
          ? 'Scholarship'
          : 'Account',
      subCategory: 'Admin Announcement',
      priority:
        announcement.category === 'Deadline' || announcement.category === 'Maintenance'
          ? 'High'
          : 'Medium',
      announcementId: announcement.id,
      actionRoute: sanitizeInternalRoute(announcement.actionRoute, '/notifications'),
      dedupeKey,
      deliveryChannel: 'in-app',
      deliveryStatus: 'Delivered In-App',
      isRead: false,
      isArchived: false,
      createdAt: nowIso,
    };

    await setDocRest('notifications', notif.id, notif as unknown as Record<string, unknown>, idToken);
    delivered += 1;
  }

  return delivered;
}

export async function toggleAnnouncementPublishAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
  announcementId: string;
  publish: boolean;
}) {
  const { adminUid, adminEmail, adminRole, idToken, announcementId, publish } = params;
  const existing = await getDocRest<AdminAnnouncementRecord>('announcements', announcementId, idToken);
  if (!existing.data) {
    throw new CompanionError(404, 'ANNOUNCEMENT_NOT_FOUND', 'Announcement not found.');
  }

  const nowIso = new Date().toISOString();
  const updated: AdminAnnouncementRecord = {
    ...existing.data,
    status: publish ? 'Published' : 'Unpublished',
    ...(publish ? { publishedByUid: adminUid, publishedAt: nowIso } : {}),
    updatedAt: nowIso,
  };

  let deliveredCount = updated.deliveredCount ?? 0;
  if (publish && isAnnouncementActiveAt(updated)) {
    deliveredCount = await deliverAnnouncementToTargetStudentsServer({
      announcement: updated,
      idToken,
    });
    updated.deliveredCount = deliveredCount;
  }

  await setDocRest('announcements', updated.id, updated as unknown as Record<string, unknown>, idToken);

  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: publish ? 'Announcement Published' : 'Announcement Unpublished',
    entityType: 'announcement',
    entityId: updated.id,
    summary: `${publish ? 'Published' : 'Unpublished'} announcement "${updated.title}" (delivered to ${deliveredCount} targeted student(s)).`,
    nowIso,
  });
  await recordAuditLogRest(auditLog, idToken);

  return { announcement: updated, auditLog, deliveredCount };
}

// ============================================================================
// Module 3: Scheduled Notification Sweep & Background Cron Runner
// ============================================================================

export async function runAdminScheduledNotificationSweepServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
  triggerType?: ScheduledNotificationRunRecord['triggerType'];
}): Promise<{
  run: ScheduledNotificationRunRecord;
  auditLog: ReturnType<typeof buildAuditLogRecord>;
}> {
  const { adminUid, adminEmail, adminRole, idToken, triggerType = 'admin_manual' } = params;
  const startedAt = new Date().toISOString();
  const emailConfig = getServerEmailProviderConfig();

  const [
    profiles,
    scholarships,
    applications,
    savedScholarships,
    existingNotifs,
    prefsList,
    announcements,
    deliveryLogs,
  ] = await Promise.all([
    listCollectionRest<StudentProfile>('profiles', idToken, 400),
    listCollectionRest<Scholarship>('scholarships', idToken, 300),
    listCollectionRest<ApplicationRecord>('applications', idToken, 400),
    listCollectionRest<SavedScholarship>('saved_scholarships', idToken, 400),
    listCollectionRest<NotificationRecord>('notifications', idToken, 500),
    listCollectionRest<NotificationPreferenceRecord>('notification_preferences', idToken, 400),
    listCollectionRest<AdminAnnouncementRecord>('announcements', idToken, 100),
    listCollectionRest<NotificationDeliveryLogRecord>('notification_delivery_logs', idToken, 300),
  ]);

  const prefMap = new Map(prefsList.map((p) => [p.uid, p]));
  let alertsGenerated = 0;
  let emailsAttempted = 0;
  let emailsSent = 0;
  let emailsFailed = 0;

  for (const profile of profiles) {
    const uid = profile.uid;
    const studentApps = applications.filter((a) => a.userId === uid);
    const studentSaved = savedScholarships.filter((s) => s.userId === uid);
    const studentNotifs = existingNotifs.filter((n) => n.userId === uid);
    const pref = normalizeNotificationPreferences(uid, prefMap.get(uid), emailConfig.statusLabel);

    const evalRes = evaluateFullStudentNotifications({
      userId: uid,
      profile,
      scholarships,
      applications: studentApps,
      savedScholarships: studentSaved,
      announcements,
      existingNotifications: studentNotifs,
      preferences: pref,
      emailConfigured: emailConfig.configured,
    });

    for (const draft of evalRes.newNotifications) {
      let record = draft;
      if (pref.emailNotificationsEnabled) {
        emailsAttempted += 1;
        const log = await dispatchNotificationEmailWithRetries({
          userId: uid,
          recipientEmail: profile.email,
          notification: draft,
          existingLogs: deliveryLogs,
        });
        await setDocRest(
          'notification_delivery_logs',
          log.id,
          log as unknown as Record<string, unknown>,
          idToken
        );
        if (log.status === 'Sent' || log.status === 'Delivered') emailsSent += 1;
        else if (log.status === 'Failed') emailsFailed += 1;
        record = {
          ...draft,
          deliveryChannel: emailConfig.configured ? 'in-app+email' : 'in-app',
          deliveryStatus:
            log.status === 'Sent' || log.status === 'Delivered'
              ? 'Email Sent'
              : log.status === 'Not Configured'
                ? 'Email Not Configured'
                : 'Email Failed',
        };
      }
      await setDocRest(
        'notifications',
        record.id,
        record as unknown as Record<string, unknown>,
        idToken
      );
      alertsGenerated += 1;
    }
  }

  const completedAt = new Date().toISOString();
  const run: ScheduledNotificationRunRecord = {
    id: makeNotifServiceId('nrun'),
    triggerType,
    status: emailsFailed > 0 ? 'Partial' : 'Completed',
    startedAt,
    completedAt,
    scholarshipsEvaluated: scholarships.length,
    applicationsEvaluated: applications.length,
    studentsEvaluated: profiles.length,
    alertsGenerated,
    emailsAttempted,
    emailsSent,
    emailsFailed,
    triggeredByUid: adminUid,
  };

  await setDocRest('notification_runs', run.id, run as unknown as Record<string, unknown>, idToken);

  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: 'Scheduled Notification Run',
    entityType: 'notification_run',
    entityId: run.id,
    summary: `Scheduled deadline & matching sweep evaluated ${profiles.length} students, ${scholarships.length} scholarships, and ${applications.length} apps; generated ${alertsGenerated} alert(s).`,
    nowIso: completedAt,
  });
  await recordAuditLogRest(auditLog, idToken);

  return { run, auditLog };
}

let schedulerState: {
  active: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  lastRunStatus: ScheduledNotificationRunRecord['status'] | 'Idle';
  lastError: string | null;
} = {
  active: false,
  intervalMs: Number(process.env.NOTIFICATION_CRON_INTERVAL_MS || 6 * 60 * 60 * 1000),
  lastRunAt: null,
  lastRunStatus: 'Idle',
  lastError: null,
};

export function getNotificationSchedulerState() {
  return {
    ...schedulerState,
    emailProvider: getServerEmailProviderConfig(),
  };
}

async function runAutonomousBackgroundSweep(triggerType: 'startup' | 'cron_interval') {
  const startedAt = new Date().toISOString();
  try {
    const app = getApps()[0];
    if (!app) {
      schedulerState.lastRunAt = startedAt;
      schedulerState.lastRunStatus = 'Skipped (No Server Credentials)';
      return;
    }
    const adminDb = getAdminFirestore(app, firebaseConfig.firestoreDatabaseId);
    const [profilesSnap, scholarshipsSnap, appsSnap, savedSnap, notifsSnap, prefsSnap, annSnap] =
      await Promise.all([
        adminDb.collection('profiles').limit(400).get(),
        adminDb.collection('scholarships').limit(300).get(),
        adminDb.collection('applications').limit(400).get(),
        adminDb.collection('saved_scholarships').limit(400).get(),
        adminDb.collection('notifications').limit(500).get(),
        adminDb.collection('notification_preferences').limit(400).get(),
        adminDb.collection('announcements').limit(100).get(),
      ]);

    const profiles = profilesSnap.docs.map((d) => d.data() as StudentProfile);
    const scholarships = scholarshipsSnap.docs.map((d) => d.data() as Scholarship);
    const applications = appsSnap.docs.map((d) => d.data() as ApplicationRecord);
    const savedScholarships = savedSnap.docs.map((d) => d.data() as SavedScholarship);
    const existingNotifs = notifsSnap.docs.map((d) => d.data() as NotificationRecord);
    const prefsList = prefsSnap.docs.map((d) => d.data() as NotificationPreferenceRecord);
    const announcements = annSnap.docs.map((d) => d.data() as AdminAnnouncementRecord);
    const prefMap = new Map(prefsList.map((p) => [p.uid, p]));
    const emailConfig = getServerEmailProviderConfig();

    let alertsGenerated = 0;
    let emailsAttempted = 0;
    let emailsSent = 0;
    let emailsFailed = 0;

    for (const profile of profiles) {
      const uid = profile.uid;
      const pref = normalizeNotificationPreferences(uid, prefMap.get(uid), emailConfig.statusLabel);
      const evalRes = evaluateFullStudentNotifications({
        userId: uid,
        profile,
        scholarships,
        applications: applications.filter((a) => a.userId === uid),
        savedScholarships: savedScholarships.filter((s) => s.userId === uid),
        announcements,
        existingNotifications: existingNotifs.filter((n) => n.userId === uid),
        preferences: pref,
        emailConfigured: emailConfig.configured,
      });

      for (const draft of evalRes.newNotifications) {
        let record = draft;
        if (pref.emailNotificationsEnabled) {
          emailsAttempted += 1;
          const log = await dispatchNotificationEmailWithRetries({
            userId: uid,
            recipientEmail: profile.email,
            notification: draft,
          });
          await adminDb.collection('notification_delivery_logs').doc(log.id).set(log);
          if (log.status === 'Sent' || log.status === 'Delivered') emailsSent += 1;
          else if (log.status === 'Failed') emailsFailed += 1;
          record = {
            ...draft,
            deliveryChannel: emailConfig.configured ? 'in-app+email' : 'in-app',
            deliveryStatus:
              log.status === 'Sent' || log.status === 'Delivered'
                ? 'Email Sent'
                : log.status === 'Not Configured'
                  ? 'Email Not Configured'
                  : 'Email Failed',
          };
        }
        await adminDb.collection('notifications').doc(record.id).set(record);
        alertsGenerated += 1;
      }
    }

    const completedAt = new Date().toISOString();
    const run: ScheduledNotificationRunRecord = {
      id: makeNotifServiceId('nrun'),
      triggerType,
      status: emailsFailed > 0 ? 'Partial' : 'Completed',
      startedAt,
      completedAt,
      scholarshipsEvaluated: scholarships.length,
      applicationsEvaluated: applications.length,
      studentsEvaluated: profiles.length,
      alertsGenerated,
      emailsAttempted,
      emailsSent,
      emailsFailed,
    };
    await adminDb.collection('notification_runs').doc(run.id).set(run);

    schedulerState.lastRunAt = completedAt;
    schedulerState.lastRunStatus = run.status;
    schedulerState.lastError = null;
  } catch (err) {
    // Expect credential absence in local dev sandbox without ADC; handle gracefully without crashing
    const msg = err instanceof Error ? err.message : 'Background scheduler sweep failed';
    schedulerState.lastRunAt = new Date().toISOString();
    schedulerState.lastRunStatus =
      msg.includes('credential') || msg.includes('Could not load the default credentials') || msg.includes('PERMISSION_DENIED')
        ? 'Skipped (No Server Credentials)'
        : 'Failed';
    schedulerState.lastError = msg.slice(0, 300);
  }
}

export function startNotificationScheduler(): void {
  if (schedulerState.active) return;
  schedulerState.active = true;

  const intervalMs = Math.max(60_000, schedulerState.intervalMs || 6 * 60 * 60 * 1000);
  schedulerState.intervalMs = intervalMs;

  // Run initial check slightly after server boot (non-blocking), then repeat on interval
  setTimeout(() => {
    void runAutonomousBackgroundSweep('startup');
  }, 4000).unref();

  setInterval(() => {
    void runAutonomousBackgroundSweep('cron_interval');
  }, intervalMs).unref();
}
