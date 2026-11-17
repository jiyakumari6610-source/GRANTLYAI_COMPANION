import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };
import {
  deriveApplicationNotifications,
  evaluateDeadlineIntelligence,
  evaluateTrackedApplication,
  eventTypeForStatusTransition,
  EXTERNAL_PORTAL_NOTICE,
  findDuplicateActiveApplication,
  normalizeApplicationStatus,
  validateApplicationTransition,
} from '../lib/applicationTrackerEngine.ts';
import { CompanionError, fetchLiveScholarshipsFromDb, resolveStudentDatabaseSnapshot } from './companionContext.ts';
import {
  emitApplicationEventNotificationSafe,
  syncStudentNotificationsServer,
} from './notificationService.ts';
import type {
  ApplicationEventRecord,
  ApplicationRecord,
  ApplicationStatus,
  NotificationPreferenceRecord,
  NotificationRecord,
  Phase8ApplicationStatus,
  Scholarship,
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

function firestoreDocUrl(collectionPath: string, docId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/${collectionPath}/${encodeURIComponent(docId)}`;
}

async function getDocRest<T>(
  collectionPath: string,
  docId: string,
  idToken: string
): Promise<{ status: number; data: T | null }> {
  const res = await fetch(firestoreDocUrl(collectionPath, docId), {
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
  const res = await fetch(firestoreDocUrl(collectionPath, docId), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ fields: encodeFirestoreFields(payload) }),
    signal: AbortSignal.timeout(5000),
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

async function queryUserDocsRest<T extends { userId?: string }>(
  collectionId: string,
  uid: string,
  idToken: string
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
            field: { fieldPath: 'userId' },
            op: 'EQUAL',
            value: { stringValue: uid },
          },
        },
        limit: 100,
      },
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new CompanionError(
      res.status === 403 ? 403 : 502,
      'FIRESTORE_QUERY_FAILED',
      `Failed to query ${collectionId} (${res.status})`
    );
  }
  const rows = (await res.json()) as Array<{ document?: { fields?: Record<string, FirestoreValue> } }>;
  const items: T[] = [];
  for (const row of rows) {
    const decoded = decodeFirestoreDocument<T>(row.document?.fields);
    if (decoded && (!decoded.userId || decoded.userId === uid)) {
      items.push(decoded);
    }
  }
  return items;
}

export function makeServerId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ===========================================================================
// Pure Server-Authoritative Workflow Builders (Testable without network)
// ===========================================================================

export function createTrackedApplicationWorkflow(params: {
  uid: string;
  scholarship: Scholarship | null | undefined;
  existingApplications: ApplicationRecord[];
  initialStatus?: 'Interested' | 'Preparing';
  notes?: string;
  deadline?: string;
  nowIso?: string;
}): {
  application: ApplicationRecord;
  event: ApplicationEventRecord;
} {
  const {
    uid,
    scholarship,
    existingApplications,
    initialStatus = 'Interested',
    notes,
    deadline,
    nowIso = new Date().toISOString(),
  } = params;

  if (!scholarship) {
    throw new CompanionError(
      404,
      'SCHOLARSHIP_NOT_FOUND',
      'Scholarship record not found in the database. Cannot track a non-existent scholarship.'
    );
  }

  if (scholarship.verificationStatus === 'Archived') {
    throw new CompanionError(
      409,
      'SCHOLARSHIP_ARCHIVED',
      'This scholarship has been archived and cannot be added as a new active application.'
    );
  }

  const duplicate = findDuplicateActiveApplication(existingApplications, scholarship.id);
  if (duplicate) {
    throw new CompanionError(
      409,
      'DUPLICATE_ACTIVE_APPLICATION',
      `You already have an active tracked application for "${scholarship.title}" (status: ${normalizeApplicationStatus(duplicate.status)}).`
    );
  }

  const appId = makeServerId('app');
  const application: ApplicationRecord = {
    id: appId,
    userId: uid,
    scholarshipId: scholarship.id,
    scholarshipTitle: scholarship.title,
    provider: scholarship.provider,
    status: initialStatus,
    ...(deadline?.trim()
      ? { deadline: deadline.trim() }
      : scholarship.applicationDeadline
        ? { deadline: scholarship.applicationDeadline }
        : {}),
    ...(notes?.trim() ? { notes: notes.trim().slice(0, 2000) } : {}),
    lastStatusChangedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const event: ApplicationEventRecord = {
    id: makeServerId('evt'),
    applicationId: appId,
    userId: uid,
    scholarshipId: scholarship.id,
    eventType: 'Application Added',
    toStatus: initialStatus,
    description: `Started tracking "${scholarship.title}" in stage "${initialStatus}".`,
    source: 'student',
    actorUid: uid,
    createdAt: nowIso,
  };

  return { application, event };
}

export function transitionTrackedApplicationWorkflow(params: {
  uid: string;
  application: ApplicationRecord;
  scholarship: Scholarship | null | undefined;
  nextStatus: ApplicationStatus;
  submissionConfirmed?: boolean;
  submissionDate?: string;
  portalReferenceId?: string;
  correctionNotes?: string;
  finalOutcome?: string;
  notes?: string;
  deadline?: string;
  nowIso?: string;
}): {
  application: ApplicationRecord;
  event: ApplicationEventRecord;
} {
  const {
    uid,
    application,
    scholarship,
    nextStatus,
    submissionConfirmed = false,
    submissionDate,
    portalReferenceId,
    correctionNotes,
    finalOutcome,
    notes,
    deadline,
    nowIso = new Date().toISOString(),
  } = params;

  if (application.userId !== uid) {
    throw new CompanionError(
      403,
      'CROSS_STUDENT_FORBIDDEN',
      'Access denied: cannot modify an application belonging to another student.'
    );
  }

  const deadlineInfo = evaluateDeadlineIntelligence(
    scholarship,
    deadline ?? application.deadline,
    new Date(nowIso)
  );

  const check = validateApplicationTransition({
    currentStatus: application.status,
    nextStatus,
    submissionConfirmed,
    scholarshipExists: Boolean(scholarship),
    scholarshipArchived: scholarship?.verificationStatus === 'Archived',
    deadlineExpired: deadlineInfo.isExpired,
  });

  if (!check.allowed) {
    throw new CompanionError(400, 'INVALID_TRANSITION', check.reason || 'Invalid application status transition.');
  }

  const fromNorm = check.normalizedFrom;
  const toNorm: Phase8ApplicationStatus = check.normalizedTo;
  const statusChanged = fromNorm !== toNorm;

  const updated: ApplicationRecord = {
    ...application,
    status: toNorm,
    updatedAt: nowIso,
    ...(statusChanged ? { lastStatusChangedAt: nowIso } : {}),
    ...(portalReferenceId !== undefined ? { portalReferenceId: portalReferenceId.trim() || undefined } : {}),
    ...(notes !== undefined ? { notes: notes.trim().slice(0, 2000) || undefined } : {}),
    ...(deadline !== undefined ? { deadline: deadline.trim() || undefined } : {}),
    ...(correctionNotes !== undefined
      ? { correctionNotes: correctionNotes.trim().slice(0, 1000) || undefined }
      : {}),
    ...(finalOutcome !== undefined
      ? { finalOutcome: finalOutcome.trim().slice(0, 300) || undefined }
      : {}),
    ...(toNorm === 'Submitted' && submissionConfirmed
      ? {
          submissionConfirmedByStudent: true,
          submissionConfirmedAt: nowIso,
          submissionDate: submissionDate?.trim() || nowIso.slice(0, 10),
        }
      : {}),
  };

  let eventType = eventTypeForStatusTransition(toNorm);
  let description = `Status updated from "${fromNorm}" to "${toNorm}".`;
  if (!statusChanged) {
    eventType = 'Notes Updated';
    description = 'Updated application notes, reference ID, or target deadline.';
  } else if (toNorm === 'Submitted') {
    description = `Student confirmed portal submission${
      updated.portalReferenceId ? ` (Reference ID: ${updated.portalReferenceId})` : ''
    }.`;
  } else if (toNorm === 'Correction Required' && updated.correctionNotes) {
    description = `Marked Correction Required: ${updated.correctionNotes}`;
  } else if ((toNorm === 'Approved' || toNorm === 'Rejected') && updated.finalOutcome) {
    description = `Outcome recorded as "${toNorm}": ${updated.finalOutcome}`;
  }

  const event: ApplicationEventRecord = {
    id: makeServerId('evt'),
    applicationId: application.id,
    userId: uid,
    scholarshipId: application.scholarshipId,
    eventType,
    ...(statusChanged ? { fromStatus: fromNorm, toStatus: toNorm } : {}),
    description: description.slice(0, 600),
    source: 'student',
    actorUid: uid,
    createdAt: nowIso,
  };

  return { application: updated, event };
}

export function recordPortalOpenWorkflow(params: {
  uid: string;
  application: ApplicationRecord;
  nowIso?: string;
}): {
  application: ApplicationRecord;
  event: ApplicationEventRecord;
  portalNotice: string;
} {
  const { uid, application, nowIso = new Date().toISOString() } = params;
  if (application.userId !== uid) {
    throw new CompanionError(
      403,
      'CROSS_STUDENT_FORBIDDEN',
      'Access denied: cannot log portal visit for another student application.'
    );
  }

  // CRITICAL: Opening an external portal URL MUST NEVER auto-mark status as Submitted.
  const updated: ApplicationRecord = {
    ...application,
    portalOpenedAt: nowIso,
    updatedAt: nowIso,
  };

  const event: ApplicationEventRecord = {
    id: makeServerId('evt'),
    applicationId: application.id,
    userId: uid,
    scholarshipId: application.scholarshipId,
    eventType: 'External Portal Opened',
    description:
      'Opened official scholarship portal link. Application status remains unchanged until student manually confirms submission.',
    source: 'student',
    actorUid: uid,
    createdAt: nowIso,
  };

  return {
    application: updated,
    event,
    portalNotice: EXTERNAL_PORTAL_NOTICE,
  };
}

// ===========================================================================
// Authenticated Firestore-Backed Server Handlers
// ===========================================================================

export async function createApplicationServer(params: {
  uid: string;
  idToken: string;
  scholarshipId: string;
  initialStatus?: 'Interested' | 'Preparing';
  notes?: string;
  deadline?: string;
}) {
  const { uid, idToken, scholarshipId, initialStatus, notes, deadline } = params;

  const [scholarships, existingApplications] = await Promise.all([
    fetchLiveScholarshipsFromDb(),
    queryUserDocsRest<ApplicationRecord>('applications', uid, idToken),
  ]);

  const scholarship = scholarships.find((s) => s.id === scholarshipId) ?? null;
  const { application, event } = createTrackedApplicationWorkflow({
    uid,
    scholarship,
    existingApplications,
    initialStatus,
    notes,
    deadline,
  });

  await setDocRest('applications', application.id, application as unknown as Record<string, unknown>, idToken);
  await setDocRest('application_events', event.id, event as unknown as Record<string, unknown>, idToken);

  await emitApplicationEventNotificationSafe({
    uid,
    idToken,
    application,
  });

  return { application, event, scholarship };
}

export async function transitionApplicationServer(params: {
  uid: string;
  idToken: string;
  applicationId: string;
  nextStatus: ApplicationStatus;
  submissionConfirmed?: boolean;
  submissionDate?: string;
  portalReferenceId?: string;
  correctionNotes?: string;
  finalOutcome?: string;
  notes?: string;
  deadline?: string;
}) {
  const { uid, idToken, applicationId, ...rest } = params;

  const [appRes, scholarships] = await Promise.all([
    getDocRest<ApplicationRecord>('applications', applicationId, idToken),
    fetchLiveScholarshipsFromDb(),
  ]);

  if (appRes.status === 403) {
    throw new CompanionError(403, 'CROSS_STUDENT_FORBIDDEN', 'Access denied to this application record.');
  }
  if (appRes.status === 404 || !appRes.data) {
    throw new CompanionError(404, 'APPLICATION_NOT_FOUND', 'Tracked application not found.');
  }

  const scholarship = scholarships.find((s) => s.id === appRes.data!.scholarshipId) ?? null;
  const previousStatus = appRes.data.status;
  const { application, event } = transitionTrackedApplicationWorkflow({
    uid,
    application: appRes.data,
    scholarship,
    ...rest,
  });

  await setDocRest('applications', application.id, application as unknown as Record<string, unknown>, idToken);
  await setDocRest('application_events', event.id, event as unknown as Record<string, unknown>, idToken);

  if (normalizeApplicationStatus(previousStatus) !== normalizeApplicationStatus(application.status)) {
    await emitApplicationEventNotificationSafe({
      uid,
      idToken,
      application,
      previousStatus,
    });
  }

  return { application, event };
}

export async function recordPortalOpenServer(params: {
  uid: string;
  idToken: string;
  applicationId: string;
}) {
  const { uid, idToken, applicationId } = params;
  const appRes = await getDocRest<ApplicationRecord>('applications', applicationId, idToken);

  if (appRes.status === 403) {
    throw new CompanionError(403, 'CROSS_STUDENT_FORBIDDEN', 'Access denied to this application record.');
  }
  if (appRes.status === 404 || !appRes.data) {
    throw new CompanionError(404, 'APPLICATION_NOT_FOUND', 'Tracked application not found.');
  }

  const { application, event, portalNotice } = recordPortalOpenWorkflow({
    uid,
    application: appRes.data,
  });

  await setDocRest('applications', application.id, application as unknown as Record<string, unknown>, idToken);
  await setDocRest('application_events', event.id, event as unknown as Record<string, unknown>, idToken);

  return { application, event, portalNotice };
}

export async function syncNotificationsServer(params: {
  uid: string;
  idToken: string;
}): Promise<{ createdNotifications: NotificationRecord[]; totalEvaluated: number }> {
  const res = await syncStudentNotificationsServer({
    uid: params.uid,
    idToken: params.idToken,
  });

  return {
    createdNotifications: res.newNotifications,
    totalEvaluated: res.allNotifications.length,
  };
}
