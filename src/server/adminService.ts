import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };
import {
  buildSanitizedStudentOversight,
  computeAdminDashboardMetrics,
  computeTrustGuardMonitorSummary,
  detectRuleContradictions,
  normalizeAppRole,
  normalizeVerificationStatus,
  runScholarshipDataQualityScan,
  validateVerificationEvidence,
  type RuleDraftInput,
  type VerificationEvidenceInput,
} from '../lib/adminGovernanceEngine.ts';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../data/verifiedScholarships.ts';
import { CompanionError } from './companionContext.ts';
import {
  analyzeDocumentWithGemini,
  DocumentProcessingError,
  extractRealDocumentText,
  validateDocumentBinary,
} from './documentProcessor.ts';
import { adminAuth, BOOTSTRAP_ADMIN_EMAIL } from './firebaseAdmin.ts';
import { readDocumentFromCloudStorage } from './documentStorage.ts';
import type {
  AdminAuditAction,
  AdminAuditEntityType,
  AdminAuditLogRecord,
  ApplicationRecord,
  AppRole,
  DataQualityIssueRecord,
  DataQualityResolutionStatus,
  DocumentAnalysis,
  DocumentRecord,
  Scholarship,
  ScholarshipEligibilityRule,
  ScholarshipRuleSnapshotItem,
  ScholarshipRuleVersionRecord,
  ScholarshipVerificationHistoryRecord,
  StudentProfile,
  TrustGuardDocumentAssessment,
  TrustGuardReport,
  UserRoleRecord,
  VerificationStatus,
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

function firestoreBaseUrl(): string {
  return `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents`;
}

function firestoreDocUrl(collectionPath: string, docId: string): string {
  return `${firestoreBaseUrl()}/${collectionPath}/${encodeURIComponent(docId)}`;
}

export function makeAdminId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function getDocRest<T>(
  collectionPath: string,
  docId: string,
  idToken: string
): Promise<{ status: number; data: T | null }> {
  const res = await fetch(firestoreDocUrl(collectionPath, docId), {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(6000),
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
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new CompanionError(
      res.status === 403 ? 403 : 502,
      res.status === 403 ? 'FIRESTORE_PERMISSION_DENIED' : 'FIRESTORE_WRITE_FAILED',
      `Failed to write ${collectionPath}/${docId} (${res.status}): ${errText.slice(0, 200)}`
    );
  }
}

async function deleteDocRest(
  collectionPath: string,
  docId: string,
  idToken: string
): Promise<void> {
  const res = await fetch(firestoreDocUrl(collectionPath, docId), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok && res.status !== 404) {
    const errText = await res.text().catch(() => '');
    throw new CompanionError(
      res.status === 403 ? 403 : 502,
      'FIRESTORE_DELETE_FAILED',
      `Failed to delete ${collectionPath}/${docId} (${res.status}): ${errText.slice(0, 180)}`
    );
  }
}

async function listCollectionRest<T>(
  collectionId: string,
  idToken: string,
  limit = 500
): Promise<T[]> {
  const url = `${firestoreBaseUrl()}:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        limit,
      },
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new CompanionError(
      res.status === 403 ? 403 : 502,
      res.status === 403 ? 'FIRESTORE_PERMISSION_DENIED' : 'FIRESTORE_LIST_FAILED',
      `Failed to list ${collectionId} (${res.status}): ${errText.slice(0, 180)}`
    );
  }

  const rows = (await res.json()) as Array<{ document?: { fields?: Record<string, FirestoreValue> } }>;
  const items: T[] = [];
  for (const row of rows) {
    const decoded = decodeFirestoreDocument<T>(row.document?.fields);
    if (decoded) items.push(decoded);
  }
  return items;
}

async function queryByFieldRest<T>(
  collectionId: string,
  fieldPath: string,
  value: string,
  idToken: string,
  limit = 200
): Promise<T[]> {
  const url = `${firestoreBaseUrl()}:runQuery`;
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
            value: { stringValue: value },
          },
        },
        limit,
      },
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new CompanionError(
      res.status === 403 ? 403 : 502,
      'FIRESTORE_QUERY_FAILED',
      `Failed to query ${collectionId} (${res.status}): ${errText.slice(0, 180)}`
    );
  }

  const rows = (await res.json()) as Array<{ document?: { fields?: Record<string, FirestoreValue> } }>;
  const items: T[] = [];
  for (const row of rows) {
    const decoded = decodeFirestoreDocument<T>(row.document?.fields);
    if (decoded) items.push(decoded);
  }
  return items;
}

// ============================================================================
// Pure Testable Governance Workflow Builders
// ============================================================================

export function buildAuditLogRecord(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  action: AdminAuditAction;
  entityType: AdminAuditEntityType;
  entityId: string;
  summary: string;
  changesSummary?: string;
  requestId?: string;
  nowIso?: string;
}): AdminAuditLogRecord {
  const nowIso = params.nowIso ?? new Date().toISOString();
  return {
    id: makeAdminId('audit'),
    adminUid: params.adminUid,
    adminEmail: params.adminEmail.slice(0, 200),
    adminRole: params.adminRole,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId.slice(0, 128),
    summary: params.summary.slice(0, 600),
    ...(params.changesSummary ? { changesSummary: params.changesSummary.slice(0, 1200) } : {}),
    ...(params.requestId ? { requestId: params.requestId.slice(0, 128) } : {}),
    createdAt: nowIso,
  };
}

export function upsertScholarshipWorkflow(params: {
  existing: Scholarship | null;
  input: Partial<Scholarship> & {
    id?: string;
    title: string;
    provider: string;
    scholarshipType: Scholarship['scholarshipType'];
    officialUrl: string;
  };
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  nowIso?: string;
}): {
  scholarship: Scholarship;
  auditLog: AdminAuditLogRecord;
} {
  const { existing, input, adminUid, adminEmail, adminRole, nowIso = new Date().toISOString() } = params;
  const title = input.title.trim();
  const provider = input.provider.trim();
  const officialUrl = input.officialUrl.trim();

  if (title.length < 2 || provider.length < 2) {
    throw new CompanionError(400, 'INVALID_SCHOLARSHIP', 'Title and provider are required.');
  }
  if (!officialUrl.startsWith('http://') && !officialUrl.startsWith('https://')) {
    throw new CompanionError(400, 'INVALID_URL', 'Official application URL must start with http:// or https://.');
  }
  if (
    typeof input.minIncomeLimitInr === 'number' &&
    typeof input.incomeLimitInr === 'number' &&
    input.minIncomeLimitInr > input.incomeLimitInr
  ) {
    throw new CompanionError(
      400,
      'CONFLICTING_INCOME_BOUNDS',
      'Minimum income limit cannot exceed maximum income limit.'
    );
  }

  // Creating a new scholarship NEVER auto-marks Verified unless valid evidence is supplied
  const requestedStatus = input.verificationStatus
    ? normalizeVerificationStatus(input.verificationStatus)
    : existing?.verificationStatus ?? 'Pending Review';

  if (requestedStatus === 'Verified') {
    const check = validateVerificationEvidence({
      newStatus: 'Verified',
      officialSourceUrl: input.officialSourceUrl || officialUrl,
      sourceName: input.sourceName,
      sourceEvidence: input.sourceEvidence || existing?.sourceEvidence,
      humanConfirmed: true,
    });
    if (!check.valid) {
      throw new CompanionError(400, 'VERIFICATION_EVIDENCE_REQUIRED', check.reason);
    }
  }

  const scholarshipId = existing?.id || input.id || makeAdminId('sch');
  const scholarship: Scholarship = {
    ...(existing ?? {}),
    ...input,
    id: scholarshipId,
    title: title.slice(0, 240),
    provider: provider.slice(0, 200),
    officialUrl: officialUrl.slice(0, 500),
    officialSourceUrl: (input.officialSourceUrl || existing?.officialSourceUrl || officialUrl).trim().slice(0, 500),
    verificationStatus: requestedStatus,
    sourceName: (input.sourceName ?? existing?.sourceName ?? provider).slice(0, 200),
    retrievedAt: existing?.retrievedAt || input.retrievedAt || nowIso,
    isActive: requestedStatus === 'Archived' ? false : (input.isActive ?? existing?.isActive ?? true),
    activeRuleVersion: existing?.activeRuleVersion ?? input.activeRuleVersion ?? 1,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: existing ? 'Scholarship Updated' : 'Scholarship Created',
    entityType: 'scholarship',
    entityId: scholarship.id,
    summary: `${existing ? 'Updated' : 'Created'} scholarship "${scholarship.title}" (${scholarship.verificationStatus}).`,
    changesSummary: existing
      ? `Status: ${existing.verificationStatus} -> ${scholarship.verificationStatus}; Deadline: ${scholarship.applicationDeadline || 'N/A'}`
      : `Provider: ${scholarship.provider}; Source: ${scholarship.officialSourceUrl}`,
    nowIso,
  });

  return { scholarship, auditLog };
}

export function archiveScholarshipWorkflow(params: {
  existing: Scholarship;
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  reason?: string;
  nowIso?: string;
}): {
  scholarship: Scholarship;
  auditLog: AdminAuditLogRecord;
} {
  const { existing, adminUid, adminEmail, adminRole, reason, nowIso = new Date().toISOString() } = params;
  const scholarship: Scholarship = {
    ...existing,
    verificationStatus: 'Archived',
    isActive: false,
    archivedAt: nowIso,
    archivedByUid: adminUid,
    ...(reason?.trim() ? { verificationNotes: reason.trim().slice(0, 1000) } : {}),
    updatedAt: nowIso,
  };

  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: 'Scholarship Archived',
    entityType: 'scholarship',
    entityId: existing.id,
    summary: `Archived scholarship "${existing.title}" while preserving student application relationships.`,
    ...(reason?.trim() ? { changesSummary: `Reason: ${reason.trim().slice(0, 400)}` } : {}),
    nowIso,
  });

  return { scholarship, auditLog };
}

export function verifyScholarshipWorkflow(params: {
  existing: Scholarship;
  input: VerificationEvidenceInput & { httpCheckStatus?: number | null };
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  nowIso?: string;
}): {
  scholarship: Scholarship;
  history: ScholarshipVerificationHistoryRecord;
  auditLog: AdminAuditLogRecord;
} {
  const { existing, input, adminUid, adminEmail, adminRole, nowIso = new Date().toISOString() } = params;
  const check = validateVerificationEvidence(input);
  if (!check.valid) {
    throw new CompanionError(400, 'VERIFICATION_VALIDATION_FAILED', check.reason);
  }

  const nextStatus: VerificationStatus = normalizeVerificationStatus(input.newStatus);
  const previousStatus = existing.verificationStatus;
  const sourceUrl = (input.officialSourceUrl || existing.officialSourceUrl || existing.officialUrl).trim();
  const evidence = (input.sourceEvidence || existing.sourceEvidence || 'Official portal review').trim();

  const scholarship: Scholarship = {
    ...existing,
    verificationStatus: nextStatus,
    officialSourceUrl: sourceUrl,
    ...(input.sourceName?.trim() ? { sourceName: input.sourceName.trim().slice(0, 200) } : {}),
    sourceEvidence: evidence.slice(0, 1500),
    ...(input.verificationNotes?.trim()
      ? { verificationNotes: input.verificationNotes.trim().slice(0, 1000) }
      : {}),
    ...(nextStatus === 'Verified'
      ? {
          lastVerifiedDate: nowIso.slice(0, 10),
          verifiedByUid: adminUid,
          verifiedByEmail: adminEmail,
        }
      : {}),
    isActive: nextStatus === 'Archived' ? false : true,
    updatedAt: nowIso,
  };

  const history: ScholarshipVerificationHistoryRecord = {
    id: makeAdminId('verhist'),
    scholarshipId: existing.id,
    scholarshipTitle: existing.title,
    previousStatus,
    newStatus: nextStatus,
    ...(scholarship.sourceName ? { sourceName: scholarship.sourceName } : {}),
    officialSourceUrl: sourceUrl,
    sourceEvidence: evidence.slice(0, 1500),
    ...(input.verificationNotes?.trim()
      ? { verificationNotes: input.verificationNotes.trim().slice(0, 1000) }
      : {}),
    ...(typeof input.httpCheckStatus === 'number' ? { httpCheckStatus: input.httpCheckStatus } : {}),
    adminUid,
    adminEmail,
    createdAt: nowIso,
  };

  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: 'Scholarship Verification Changed',
    entityType: 'scholarship',
    entityId: existing.id,
    summary: `Verification status for "${existing.title}" updated: ${previousStatus} -> ${nextStatus}.`,
    changesSummary: `Source: ${sourceUrl} | Evidence: ${evidence.slice(0, 250)}`,
    nowIso,
  });

  return { scholarship, history, auditLog };
}

export function saveEligibilityRulesWorkflow(params: {
  scholarship: Scholarship;
  existingRules: ScholarshipEligibilityRule[];
  draftRules: RuleDraftInput[];
  changeSummary: string;
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  nowIso?: string;
}): {
  rulesToSave: ScholarshipEligibilityRule[];
  rulesToDeleteIds: string[];
  versionRecord: ScholarshipRuleVersionRecord;
  updatedScholarship: Scholarship;
  auditLog: AdminAuditLogRecord;
} {
  const {
    scholarship,
    existingRules,
    draftRules,
    changeSummary,
    adminUid,
    adminEmail,
    adminRole,
    nowIso = new Date().toISOString(),
  } = params;

  const contradictions = detectRuleContradictions(draftRules);
  if (contradictions.length > 0) {
    throw new CompanionError(
      400,
      'INVALID_OR_CONTRADICTORY_RULES',
      contradictions.join(' ')
    );
  }

  const nextVersion = Math.max(
    scholarship.activeRuleVersion ?? 1,
    ...existingRules.map((r) => r.versionNumber ?? 1)
  ) + 1;

  const existingMap = new Map(existingRules.map((r) => [r.id, r]));
  const rulesToSave: ScholarshipEligibilityRule[] = draftRules.map((d) => {
    const id = d.id && existingMap.has(d.id) ? d.id : makeAdminId('rule');
    const prev = existingMap.get(id);
    return {
      id,
      scholarshipId: scholarship.id,
      ruleKey: d.ruleKey.trim(),
      ruleLabel: d.ruleLabel.trim(),
      operator: d.operator,
      ruleValue: d.ruleValue.trim(),
      isMandatory: Boolean(d.isMandatory),
      isActive: d.isActive !== false,
      versionNumber: nextVersion,
      ...(d.description?.trim() ? { description: d.description.trim().slice(0, 500) } : {}),
      updatedByUid: adminUid,
      createdAt: prev?.createdAt || nowIso,
      updatedAt: nowIso,
    };
  });

  const retainedIds = new Set(rulesToSave.map((r) => r.id));
  const rulesToDeleteIds = existingRules.filter((r) => !retainedIds.has(r.id)).map((r) => r.id);

  const snapshotItems: ScholarshipRuleSnapshotItem[] = rulesToSave.map((r) => ({
    id: r.id,
    ruleKey: r.ruleKey,
    ruleLabel: r.ruleLabel,
    operator: r.operator,
    ruleValue: r.ruleValue,
    isMandatory: r.isMandatory,
    isActive: r.isActive !== false,
  }));

  const versionRecord: ScholarshipRuleVersionRecord = {
    id: makeAdminId('rver'),
    scholarshipId: scholarship.id,
    versionNumber: nextVersion,
    changeSummary: (changeSummary.trim() || `Updated eligibility rules to v${nextVersion}`).slice(0, 500),
    rulesSnapshot: snapshotItems,
    changedByUid: adminUid,
    changedByEmail: adminEmail,
    createdAt: nowIso,
  };

  const updatedScholarship: Scholarship = {
    ...scholarship,
    activeRuleVersion: nextVersion,
    updatedAt: nowIso,
  };

  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: existingRules.length === 0 ? 'Rule Created' : 'Rule Updated',
    entityType: 'eligibility_rule',
    entityId: scholarship.id,
    summary: `Saved ${rulesToSave.length} rule(s) for "${scholarship.title}" as rule version v${nextVersion}.`,
    changesSummary: versionRecord.changeSummary,
    nowIso,
  });

  return { rulesToSave, rulesToDeleteIds, versionRecord, updatedScholarship, auditLog };
}

export function assignUserRoleWorkflow(params: {
  callerUid: string;
  callerEmail: string;
  callerRole: 'student' | 'admin' | 'super_admin';
  targetUid: string;
  targetEmail: string;
  targetDisplayName?: string;
  newRole: AppRole;
  status: 'active' | 'disabled';
  existingRoles: UserRoleRecord[];
  nowIso?: string;
}): {
  roleRecord: UserRoleRecord;
  auditLog: AdminAuditLogRecord;
} {
  const {
    callerUid,
    callerEmail,
    callerRole,
    targetUid,
    targetEmail,
    targetDisplayName,
    newRole,
    status,
    existingRoles,
    nowIso = new Date().toISOString(),
  } = params;

  if (callerRole !== 'super_admin') {
    throw new CompanionError(
      403,
      'SUPER_ADMIN_REQUIRED',
      'Only an authorized Super Admin may assign, promote, demote, or disable administrator roles.'
    );
  }

  if (
    targetEmail.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase() &&
    (newRole !== 'super_admin' || status === 'disabled')
  ) {
    throw new CompanionError(
      409,
      'BOOTSTRAP_SUPER_ADMIN_PROTECTED',
      'Cannot demote or disable the primary bootstrap Super Admin account.'
    );
  }

  const prev = existingRoles.find((r) => r.uid === targetUid);
  if (prev?.role === 'super_admin' && (newRole !== 'super_admin' || status === 'disabled')) {
    const activeSuperAdmins = existingRoles.filter(
      (r) => r.role === 'super_admin' && r.status !== 'disabled'
    );
    if (activeSuperAdmins.length <= 1 && targetEmail.toLowerCase() !== BOOTSTRAP_ADMIN_EMAIL.toLowerCase()) {
      throw new CompanionError(
        409,
        'LAST_SUPER_ADMIN_PROTECTED',
        'Cannot demote or disable the last active Super Admin.'
      );
    }
  }

  const roleRecord: UserRoleRecord = {
    uid: targetUid,
    role: newRole,
    email: targetEmail,
    ...(targetDisplayName ? { displayName: targetDisplayName.slice(0, 160) } : {}),
    status,
    assignedBy: callerUid,
    assignedByEmail: callerEmail,
    createdAt: prev?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  const auditLog = buildAuditLogRecord({
    adminUid: callerUid,
    adminEmail: callerEmail,
    adminRole: 'super_admin',
    action: 'Role Updated',
    entityType: 'user_role',
    entityId: targetUid,
    summary: `Updated role for ${targetEmail} (${targetUid}) to "${newRole}" [${status}].`,
    changesSummary: `Previous role: ${prev?.role ?? 'student'} -> New role: ${newRole} (${status})`,
    nowIso,
  });

  return { roleRecord, auditLog };
}

export function resolveDataQualityIssueWorkflow(params: {
  existing: DataQualityIssueRecord;
  resolutionStatus: DataQualityResolutionStatus;
  resolutionNote?: string;
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  nowIso?: string;
}): {
  issue: DataQualityIssueRecord;
  auditLog: AdminAuditLogRecord;
} {
  const { existing, resolutionStatus, resolutionNote, adminUid, adminEmail, adminRole, nowIso = new Date().toISOString() } = params;
  const issue: DataQualityIssueRecord = {
    ...existing,
    resolutionStatus,
    ...(resolutionNote?.trim() ? { resolutionNote: resolutionNote.trim().slice(0, 600) } : {}),
    ...(resolutionStatus === 'Resolved' || resolutionStatus === 'Ignored'
      ? { resolvedAt: nowIso, resolvedByUid: adminUid }
      : {}),
    updatedAt: nowIso,
  };

  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: 'Data Quality Issue Resolved',
    entityType: 'data_quality',
    entityId: existing.id,
    summary: `Marked data quality issue (${existing.issueType}) on "${existing.scholarshipTitle}" as ${resolutionStatus}.`,
    ...(resolutionNote?.trim() ? { changesSummary: resolutionNote.trim().slice(0, 400) } : {}),
    nowIso,
  });

  return { issue, auditLog };
}

// ============================================================================
// Server Firestore-Backed Admin Operations
// ============================================================================

export async function recordAuditLogRest(log: AdminAuditLogRecord, idToken: string): Promise<void> {
  await setDocRest('admin_audit_logs', log.id, log as unknown as Record<string, unknown>, idToken);
}

export async function logAdminSessionServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  action?: 'Admin Login' | 'Admin Access Verified';
  idToken: string;
}): Promise<AdminAuditLogRecord> {
  const log = buildAuditLogRecord({
    adminUid: params.adminUid,
    adminEmail: params.adminEmail,
    adminRole: params.adminRole,
    action: params.action ?? 'Admin Login',
    entityType: 'session',
    entityId: params.adminUid,
    summary: `Authenticated ${params.adminRole} access verified for ${params.adminEmail}.`,
  });
  await recordAuditLogRest(log, params.idToken);
  return log;
}

export async function getAdminOverviewServer(params: { idToken: string }) {
  const { idToken } = params;
  const [
    profiles,
    scholarships,
    rules,
    applications,
    documents,
    documentAnalyses,
    trustGuardReports,
    trustGuardAssessments,
    dataQualityIssues,
    auditLogs,
  ] = await Promise.all([
    listCollectionRest<StudentProfile>('profiles', idToken),
    listCollectionRest<Scholarship>('scholarships', idToken),
    listCollectionRest<ScholarshipEligibilityRule>('scholarship_eligibility_rules', idToken),
    listCollectionRest<ApplicationRecord>('applications', idToken),
    listCollectionRest<DocumentRecord>('documents', idToken),
    listCollectionRest<DocumentAnalysis>('document_analysis', idToken),
    listCollectionRest<TrustGuardReport>('trustguard_reports', idToken),
    listCollectionRest<TrustGuardDocumentAssessment>('trustguard_assessments', idToken),
    listCollectionRest<DataQualityIssueRecord>('data_quality_issues', idToken),
    listCollectionRest<AdminAuditLogRecord>('admin_audit_logs', idToken, 100),
  ]);

  const metrics = computeAdminDashboardMetrics({
    profiles,
    scholarships,
    rules,
    applications,
    documents,
    documentAnalyses,
    trustGuardReports,
    trustGuardAssessments,
    dataQualityIssues,
  });

  const sortedLogs = [...auditLogs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  return { metrics, recentAuditLogs: sortedLogs };
}

export async function seedVerifiedScholarshipsAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
}) {
  const { adminUid, adminEmail, adminRole, idToken } = params;
  const nowIso = new Date().toISOString();

  await Promise.all(
    VERIFIED_INDIAN_SCHOLARSHIPS.map((item) => {
      const enriched: Scholarship = {
        ...item,
        sourceName: item.provider,
        officialSourceUrl: item.officialSourceUrl || item.officialUrl,
        retrievedAt: item.retrievedAt || nowIso,
        sourceEvidence: item.sourceNotes || 'Official government/foundation scheme catalog record.',
        isActive: true,
        activeRuleVersion: item.activeRuleVersion ?? 1,
      };
      return setDocRest('scholarships', enriched.id, enriched as unknown as Record<string, unknown>, idToken);
    })
  );

  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: 'Scholarship Updated',
    entityType: 'scholarship',
    entityId: 'verified-catalog-sync',
    summary: `Synced ${VERIFIED_INDIAN_SCHOLARSHIPS.length} verified Indian scholarship schemes into Firestore.`,
    nowIso,
  });
  await recordAuditLogRest(auditLog, idToken);

  return { count: VERIFIED_INDIAN_SCHOLARSHIPS.length };
}

export async function listScholarshipsAdminServer(params: { idToken: string }) {
  const [scholarships, rules] = await Promise.all([
    listCollectionRest<Scholarship>('scholarships', params.idToken),
    listCollectionRest<ScholarshipEligibilityRule>('scholarship_eligibility_rules', params.idToken),
  ]);
  return {
    scholarships: scholarships.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    rules,
  };
}

export async function upsertScholarshipAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
  payload: Parameters<typeof upsertScholarshipWorkflow>[0]['input'];
}) {
  const { adminUid, adminEmail, adminRole, idToken, payload } = params;
  const existingRes = payload.id
    ? await getDocRest<Scholarship>('scholarships', payload.id, idToken)
    : { status: 404, data: null };

  const { scholarship, auditLog } = upsertScholarshipWorkflow({
    existing: existingRes.data,
    input: payload,
    adminUid,
    adminEmail,
    adminRole,
  });

  await setDocRest('scholarships', scholarship.id, scholarship as unknown as Record<string, unknown>, idToken);
  await recordAuditLogRest(auditLog, idToken);
  return { scholarship, auditLog };
}

export async function archiveScholarshipAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
  scholarshipId: string;
  reason?: string;
}) {
  const { adminUid, adminEmail, adminRole, idToken, scholarshipId, reason } = params;
  const existingRes = await getDocRest<Scholarship>('scholarships', scholarshipId, idToken);
  if (!existingRes.data) {
    throw new CompanionError(404, 'SCHOLARSHIP_NOT_FOUND', 'Scholarship record not found.');
  }

  const { scholarship, auditLog } = archiveScholarshipWorkflow({
    existing: existingRes.data,
    adminUid,
    adminEmail,
    adminRole,
    reason,
  });

  await setDocRest('scholarships', scholarship.id, scholarship as unknown as Record<string, unknown>, idToken);
  await recordAuditLogRest(auditLog, idToken);
  return { scholarship, auditLog };
}

export async function getVerificationHistoryAdminServer(params: {
  idToken: string;
  scholarshipId?: string;
}) {
  const rows = params.scholarshipId
    ? await queryByFieldRest<ScholarshipVerificationHistoryRecord>(
        'scholarship_verification_history',
        'scholarshipId',
        params.scholarshipId,
        params.idToken
      )
    : await listCollectionRest<ScholarshipVerificationHistoryRecord>(
        'scholarship_verification_history',
        params.idToken,
        200
      );
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function verifyScholarshipAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
  scholarshipId: string;
  input: VerificationEvidenceInput & { httpCheckStatus?: number | null };
}) {
  const { adminUid, adminEmail, adminRole, idToken, scholarshipId, input } = params;
  const existingRes = await getDocRest<Scholarship>('scholarships', scholarshipId, idToken);
  if (!existingRes.data) {
    throw new CompanionError(404, 'SCHOLARSHIP_NOT_FOUND', 'Scholarship record not found.');
  }

  const { scholarship, history, auditLog } = verifyScholarshipWorkflow({
    existing: existingRes.data,
    input,
    adminUid,
    adminEmail,
    adminRole,
  });

  await setDocRest('scholarships', scholarship.id, scholarship as unknown as Record<string, unknown>, idToken);
  await setDocRest(
    'scholarship_verification_history',
    history.id,
    history as unknown as Record<string, unknown>,
    idToken
  );
  await recordAuditLogRest(auditLog, idToken);

  return { scholarship, history, auditLog };
}

export async function getScholarshipRulesAdminServer(params: {
  idToken: string;
  scholarshipId: string;
}) {
  const [rules, versions] = await Promise.all([
    queryByFieldRest<ScholarshipEligibilityRule>(
      'scholarship_eligibility_rules',
      'scholarshipId',
      params.scholarshipId,
      params.idToken
    ),
    queryByFieldRest<ScholarshipRuleVersionRecord>(
      'scholarship_rule_versions',
      'scholarshipId',
      params.scholarshipId,
      params.idToken
    ),
  ]);
  return {
    rules: rules.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    versions: versions.sort((a, b) => b.versionNumber - a.versionNumber),
  };
}

export async function saveScholarshipRulesAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
  scholarshipId: string;
  rules: RuleDraftInput[];
  changeSummary: string;
}) {
  const { adminUid, adminEmail, adminRole, idToken, scholarshipId, rules, changeSummary } = params;
  const schRes = await getDocRest<Scholarship>('scholarships', scholarshipId, idToken);
  if (!schRes.data) {
    throw new CompanionError(404, 'SCHOLARSHIP_NOT_FOUND', 'Scholarship record not found.');
  }

  const existingRules = await queryByFieldRest<ScholarshipEligibilityRule>(
    'scholarship_eligibility_rules',
    'scholarshipId',
    scholarshipId,
    idToken
  );

  const result = saveEligibilityRulesWorkflow({
    scholarship: schRes.data,
    existingRules,
    draftRules: rules,
    changeSummary,
    adminUid,
    adminEmail,
    adminRole,
  });

  await Promise.all([
    ...result.rulesToSave.map((r) =>
      setDocRest('scholarship_eligibility_rules', r.id, r as unknown as Record<string, unknown>, idToken)
    ),
    ...result.rulesToDeleteIds.map((id) =>
      deleteDocRest('scholarship_eligibility_rules', id, idToken)
    ),
    setDocRest(
      'scholarship_rule_versions',
      result.versionRecord.id,
      result.versionRecord as unknown as Record<string, unknown>,
      idToken
    ),
    setDocRest(
      'scholarships',
      result.updatedScholarship.id,
      result.updatedScholarship as unknown as Record<string, unknown>,
      idToken
    ),
    recordAuditLogRest(result.auditLog, idToken),
  ]);

  return result;
}

export async function getDataQualityAdminServer(params: { idToken: string }) {
  const [issues, scholarships, rules] = await Promise.all([
    listCollectionRest<DataQualityIssueRecord>('data_quality_issues', params.idToken),
    listCollectionRest<Scholarship>('scholarships', params.idToken),
    listCollectionRest<ScholarshipEligibilityRule>('scholarship_eligibility_rules', params.idToken),
  ]);

  const livePreview = runScholarshipDataQualityScan({
    scholarships,
    rules,
    existingIssues: issues,
  });

  return {
    persistedIssues: issues.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    liveIssues: livePreview,
  };
}

export async function runDataQualityScanAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
}) {
  const { adminUid, adminEmail, adminRole, idToken } = params;
  const [scholarships, rules, existingIssues] = await Promise.all([
    listCollectionRest<Scholarship>('scholarships', idToken),
    listCollectionRest<ScholarshipEligibilityRule>('scholarship_eligibility_rules', idToken),
    listCollectionRest<DataQualityIssueRecord>('data_quality_issues', idToken),
  ]);

  const scanned = runScholarshipDataQualityScan({
    scholarships,
    rules,
    existingIssues,
  });

  const scannedIds = new Set(scanned.map((i) => i.id));
  const nowIso = new Date().toISOString();

  // Auto-mark previously open issues as Resolved if they are no longer detected
  const autoResolved = existingIssues
    .filter((prev) => !scannedIds.has(prev.id) && prev.resolutionStatus === 'Open')
    .map((prev) => ({
      ...prev,
      resolutionStatus: 'Resolved' as const,
      resolvedAt: nowIso,
      resolvedByUid: adminUid,
      resolutionNote: 'Resolved during automated data quality scan (issue no longer present).',
      updatedAt: nowIso,
    }));

  await Promise.all([
    ...scanned.map((issue) =>
      setDocRest('data_quality_issues', issue.id, issue as unknown as Record<string, unknown>, idToken)
    ),
    ...autoResolved.map((issue) =>
      setDocRest('data_quality_issues', issue.id, issue as unknown as Record<string, unknown>, idToken)
    ),
  ]);

  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: 'Data Quality Scan',
    entityType: 'data_quality',
    entityId: 'catalog-scan',
    summary: `Executed catalog data quality scan across ${scholarships.length} scholarships: ${scanned.length} active issues detected, ${autoResolved.length} auto-resolved.`,
    nowIso,
  });
  await recordAuditLogRest(auditLog, idToken);

  return { issues: [...scanned, ...autoResolved], activeCount: scanned.length, resolvedCount: autoResolved.length };
}

export async function updateDataQualityIssueAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
  issueId: string;
  resolutionStatus: DataQualityResolutionStatus;
  resolutionNote?: string;
}) {
  const { adminUid, adminEmail, adminRole, idToken, issueId, resolutionStatus, resolutionNote } = params;
  const existingRes = await getDocRest<DataQualityIssueRecord>('data_quality_issues', issueId, idToken);
  if (!existingRes.data) {
    throw new CompanionError(404, 'ISSUE_NOT_FOUND', 'Data quality issue not found.');
  }

  const { issue, auditLog } = resolveDataQualityIssueWorkflow({
    existing: existingRes.data,
    resolutionStatus,
    resolutionNote,
    adminUid,
    adminEmail,
    adminRole,
  });

  await setDocRest('data_quality_issues', issue.id, issue as unknown as Record<string, unknown>, idToken);
  await recordAuditLogRest(auditLog, idToken);
  return { issue, auditLog };
}

export async function getStudentOversightAdminServer(params: { idToken: string }) {
  const { idToken } = params;
  const [profiles, applications, documents, trustGuardAssessments] = await Promise.all([
    listCollectionRest<StudentProfile>('profiles', idToken),
    listCollectionRest<ApplicationRecord>('applications', idToken),
    listCollectionRest<DocumentRecord>('documents', idToken),
    listCollectionRest<TrustGuardDocumentAssessment>('trustguard_assessments', idToken),
  ]);

  const students = buildSanitizedStudentOversight({
    profiles,
    applications,
    documents,
    trustGuardAssessments,
  });

  return {
    students,
    totalApplications: applications.length,
    applicationsPreview: applications
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 60)
      .map((a) => ({
        id: a.id,
        userId: a.userId,
        scholarshipId: a.scholarshipId,
        scholarshipTitle: a.scholarshipTitle,
        status: a.status,
        deadline: a.deadline,
        submissionDate: a.submissionDate,
        updatedAt: a.updatedAt,
      })),
  };
}

export async function getSensitiveStudentAccessAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
  targetUid: string;
  justification: string;
}) {
  const { adminUid, adminEmail, adminRole, idToken, targetUid, justification } = params;
  if (justification.trim().length < 8) {
    throw new CompanionError(
      400,
      'JUSTIFICATION_REQUIRED',
      'Provide a clear operational support justification (minimum 8 characters) before accessing detailed student records.'
    );
  }

  const [profileRes, applications, documents] = await Promise.all([
    getDocRest<StudentProfile>('profiles', targetUid, idToken),
    queryByFieldRest<ApplicationRecord>('applications', 'userId', targetUid, idToken),
    queryByFieldRest<DocumentRecord>('documents', 'userId', targetUid, idToken),
  ]);

  if (!profileRes.data) {
    throw new CompanionError(404, 'STUDENT_NOT_FOUND', 'Student profile not found.');
  }

  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: 'Sensitive Student Record Accessed',
    entityType: 'student',
    entityId: targetUid,
    summary: `Audited operational inspection of student ${targetUid} (${profileRes.data.fullName}).`,
    changesSummary: `Justification: ${justification.trim().slice(0, 400)}`,
  });
  await recordAuditLogRest(auditLog, idToken);

  return {
    student: {
      uid: profileRes.data.uid,
      fullName: profileRes.data.fullName,
      state: profileRes.data.state,
      district: profileRes.data.district,
      educationLevel: profileRes.data.educationLevel,
      courseSpecialization: profileRes.data.courseSpecialization,
      category: profileRes.data.category,
      onboardingCompleted: profileRes.data.onboardingCompleted,
      updatedAt: profileRes.data.updatedAt,
    },
    applications: applications.map((a) => ({
      id: a.id,
      scholarshipTitle: a.scholarshipTitle,
      status: a.status,
      deadline: a.deadline,
      updatedAt: a.updatedAt,
    })),
    documents: documents.map((d) => ({
      id: d.id,
      documentType: d.documentType,
      processingStatus: d.processingStatus ?? 'Pending',
      verificationStatus: d.verificationStatus,
      errorDetails: d.errorDetails,
      updatedAt: d.updatedAt,
    })),
    auditLog,
  };
}

export async function getDocumentMonitorAdminServer(params: { idToken: string }) {
  const [documents, analyses] = await Promise.all([
    listCollectionRest<DocumentRecord>('documents', params.idToken),
    listCollectionRest<DocumentAnalysis>('document_analysis', params.idToken),
  ]);

  const analysisByDoc = new Map<string, DocumentAnalysis>();
  for (const a of [...analyses].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (!analysisByDoc.has(a.documentId)) analysisByDoc.set(a.documentId, a);
  }

  const jobs = documents
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((d) => {
      const latest = analysisByDoc.get(d.id);
      const processingStatus =
        d.processingStatus ??
        (d.verificationStatus === 'Verified' || d.verificationStatus === 'Analyzed'
          ? 'Completed'
          : d.verificationStatus === 'Needs Attention'
            ? 'Needs Review'
            : 'Pending');
      return {
        id: d.id,
        userId: d.userId,
        documentType: d.documentType,
        fileName: d.fileName,
        mimeType: d.mimeType,
        fileSizeBytes: d.fileSizeBytes,
        storageProvider: d.storageProvider,
        processingStatus,
        verificationStatus: d.verificationStatus,
        errorDetails: d.errorDetails,
        extractionMethod: d.extractionMethod,
        pageCount: d.pageCount,
        lastAnalyzedAt: d.lastAnalyzedAt,
        readabilityStatus: latest?.readabilityStatus,
        readinessVerdict: latest?.readinessVerdict,
        updatedAt: d.updatedAt,
      };
    });

  const errorPatternCounts = new Map<string, number>();
  for (const j of jobs) {
    if (j.errorDetails) {
      const key = j.errorDetails.slice(0, 80);
      errorPatternCounts.set(key, (errorPatternCounts.get(key) ?? 0) + 1);
    }
  }

  return {
    jobs,
    repeatedFailures: Array.from(errorPatternCounts.entries())
      .map(([pattern, count]) => ({ pattern, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export async function retryDocumentProcessingAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
  docId: string;
}) {
  const { adminUid, adminEmail, adminRole, idToken, docId } = params;
  const docRes = await getDocRest<DocumentRecord>('documents', docId, idToken);
  if (!docRes.data) {
    throw new CompanionError(404, 'DOCUMENT_NOT_FOUND', 'Document metadata record not found.');
  }

  const doc = docRes.data;
  const nowIso = new Date().toISOString();

  // Log retry trigger immediately
  const triggerLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: 'Document Retry Triggered',
    entityType: 'document',
    entityId: doc.id,
    summary: `Admin triggered real OCR/Gemini retry for document ${doc.id} (${doc.documentType}, owner ${doc.userId}).`,
    nowIso,
  });
  await recordAuditLogRest(triggerLog, idToken);

  // Set Processing status while real job runs
  await setDocRest(
    'documents',
    doc.id,
    {
      ...doc,
      processingStatus: 'Processing',
      updatedAt: nowIso,
    },
    idToken
  );

  try {
    const stored = await readDocumentFromCloudStorage({
      userId: doc.userId,
      docId: doc.id,
      idToken,
    });
    if (!stored) {
      throw new DocumentProcessingError(
        'UNREADABLE_CONTENT',
        'Original file binary is not present in Firebase Cloud Storage. Student must re-upload this file.',
        404
      );
    }

    const normalizedMime = validateDocumentBinary(
      stored.buffer,
      stored.meta.mimeType,
      stored.meta.fileName
    );
    const rawExtraction = await extractRealDocumentText(stored.buffer, normalizedMime);
    const profileRes = await getDocRest<StudentProfile>('profiles', doc.userId, idToken);

    const result = await analyzeDocumentWithGemini({
      buffer: stored.buffer,
      rawExtraction,
      declaredCategory: doc.documentType,
      fileName: stored.meta.fileName,
      studentProfile: profileRes.data ? (profileRes.data as unknown as Record<string, unknown>) : null,
      selectedScholarship: null,
    });

    const finishedIso = new Date().toISOString();
    const analysisId = makeAdminId('docana');
    const analysisPayload: DocumentAnalysis = {
      id: analysisId,
      userId: doc.userId,
      documentId: doc.id,
      detectedType: result.analysis.detectedType,
      readabilityStatus: result.analysis.readabilityStatus,
      extractionMethod: rawExtraction.extractionMethod,
      pageCount: rawExtraction.pageCount,
      rawTextPreview: result.rawTextPreview,
      issuingAuthority: result.analysis.issuingAuthority,
      validityNotes: result.analysis.validityNotes,
      expiryWarning: result.analysis.expiryWarning,
      overallConfidence: result.analysis.overallConfidence,
      extractedFields: result.analysis.extractedFields,
      ...(result.analysis.marksheetSummary ? { marksheetSummary: result.analysis.marksheetSummary } : {}),
      missingFields: result.analysis.missingFields,
      unreadableFields: result.analysis.unreadableFields,
      profileMismatches: result.analysis.profileMismatches,
      manualVerificationItems: result.analysis.manualVerificationItems,
      issuesFound: result.analysis.issuesFound,
      recommendations: result.analysis.recommendations,
      readinessVerdict: result.analysis.readinessVerdict,
      disclaimer: result.disclaimer,
      createdAt: finishedIso,
    };

    const updatedDoc: DocumentRecord = {
      ...doc,
      processingStatus: result.processingStatus,
      verificationStatus: result.verificationStatus,
      extractionMethod: rawExtraction.extractionMethod,
      pageCount: rawExtraction.pageCount,
      lastAnalyzedAt: finishedIso,
      errorDetails: undefined,
      updatedAt: finishedIso,
    };
    const cleanDoc = { ...updatedDoc } as Record<string, unknown>;
    delete cleanDoc.errorDetails;

    await setDocRest('document_analysis', analysisId, analysisPayload as unknown as Record<string, unknown>, idToken);
    await setDocRest('documents', doc.id, cleanDoc, idToken);

    return {
      success: true,
      document: updatedDoc,
      analysisId,
    };
  } catch (err) {
    const failedIso = new Date().toISOString();
    const errMsg =
      err instanceof Error ? err.message.slice(0, 750) : 'Document retry failed during OCR/AI analysis.';

    const failedDoc: DocumentRecord = {
      ...doc,
      processingStatus: 'Failed',
      errorDetails: errMsg,
      updatedAt: failedIso,
    };

    await setDocRest('documents', doc.id, failedDoc as unknown as Record<string, unknown>, idToken);
    return {
      success: false,
      document: failedDoc,
      error: errMsg,
    };
  }
}

export async function getTrustGuardMonitorAdminServer(params: { idToken: string }) {
  const [reports, assessments] = await Promise.all([
    listCollectionRest<TrustGuardReport>('trustguard_reports', params.idToken),
    listCollectionRest<TrustGuardDocumentAssessment>('trustguard_assessments', params.idToken),
  ]);

  const systemSummary = computeTrustGuardMonitorSummary(assessments);
  return {
    reports: reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    systemSummary,
  };
}

export async function moderateTrustGuardReportAdminServer(params: {
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  idToken: string;
  reportId: string;
  status: TrustGuardReport['status'];
  adminNotes?: string;
}) {
  const { adminUid, adminEmail, adminRole, idToken, reportId, status, adminNotes } = params;
  const repRes = await getDocRest<TrustGuardReport>('trustguard_reports', reportId, idToken);
  if (!repRes.data) {
    throw new CompanionError(404, 'REPORT_NOT_FOUND', 'TrustGuard report not found.');
  }
  if (repRes.data.status === 'Confirmed Scam') {
    throw new CompanionError(
      409,
      'TERMINAL_REPORT_LOCKED',
      'Reports marked Confirmed Scam are locked and cannot be reverted.'
    );
  }

  const nowIso = new Date().toISOString();
  const updated: TrustGuardReport = {
    ...repRes.data,
    status,
    adminNotes: (adminNotes?.trim() || `Moderated by ${adminEmail}`).slice(0, 1000),
    updatedAt: nowIso,
  };

  await setDocRest('trustguard_reports', updated.id, updated as unknown as Record<string, unknown>, idToken);
  const auditLog = buildAuditLogRecord({
    adminUid,
    adminEmail,
    adminRole,
    action: 'TrustGuard Report Moderated',
    entityType: 'trustguard_report',
    entityId: updated.id,
    summary: `Moderated TrustGuard scam report ${updated.id}: ${repRes.data.status} -> ${status}.`,
    changesSummary: updated.adminNotes,
    nowIso,
  });
  await recordAuditLogRest(auditLog, idToken);

  return { report: updated, auditLog };
}

export async function listAuditLogsAdminServer(params: { idToken: string }) {
  const logs = await listCollectionRest<AdminAuditLogRecord>('admin_audit_logs', params.idToken, 500);
  return logs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listRolesAdminServer(params: { idToken: string }) {
  const roles = await listCollectionRest<UserRoleRecord>('user_roles', params.idToken, 200);
  const sorted = [...roles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    roles: sorted,
    bootstrapSuperAdminEmail: BOOTSTRAP_ADMIN_EMAIL,
  };
}

export async function assignRoleAdminServer(params: {
  callerUid: string;
  callerEmail: string;
  callerRole: 'student' | 'admin' | 'super_admin';
  idToken: string;
  targetUid?: string;
  targetEmail?: string;
  role: AppRole;
  status: 'active' | 'disabled';
}) {
  const { callerUid, callerEmail, callerRole, idToken, targetUid, targetEmail, role, status } = params;
  if (callerRole !== 'super_admin') {
    throw new CompanionError(403, 'SUPER_ADMIN_REQUIRED', 'Super Admin access is required.');
  }

  let resolvedUid = targetUid?.trim();
  let resolvedEmail = targetEmail?.trim();
  let resolvedDisplayName: string | undefined;

  if (!resolvedUid && resolvedEmail) {
    try {
      const userRecord = await adminAuth.getUserByEmail(resolvedEmail);
      resolvedUid = userRecord.uid;
      resolvedEmail = userRecord.email ?? resolvedEmail;
      resolvedDisplayName = userRecord.displayName ?? undefined;
    } catch {
      throw new CompanionError(
        404,
        'USER_NOT_FOUND',
        `No registered Firebase account found for email "${resolvedEmail}". The user must sign up first.`
      );
    }
  } else if (resolvedUid && !resolvedEmail) {
    try {
      const userRecord = await adminAuth.getUser(resolvedUid);
      resolvedEmail = userRecord.email ?? 'unknown@user';
      resolvedDisplayName = userRecord.displayName ?? undefined;
    } catch {
      throw new CompanionError(404, 'USER_NOT_FOUND', `No Firebase account found for UID "${resolvedUid}".`);
    }
  }

  if (!resolvedUid || !resolvedEmail) {
    throw new CompanionError(400, 'MISSING_TARGET_USER', 'Specify either targetUid or targetEmail.');
  }

  const existingRoles = await listCollectionRest<UserRoleRecord>('user_roles', idToken, 200);
  const { roleRecord, auditLog } = assignUserRoleWorkflow({
    callerUid,
    callerEmail,
    callerRole: normalizeAppRole(callerRole),
    targetUid: resolvedUid,
    targetEmail: resolvedEmail,
    targetDisplayName: resolvedDisplayName,
    newRole: role,
    status,
    existingRoles,
  });

  await setDocRest('user_roles', roleRecord.uid, roleRecord as unknown as Record<string, unknown>, idToken);
  await recordAuditLogRest(auditLog, idToken);

  return { roleRecord, auditLog };
}
