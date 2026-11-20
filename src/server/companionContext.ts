import { getApps, initializeApp } from 'firebase/app';
import { collection, getDocs, getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };
import { mergeCatalogWithVerifiedAdditions } from '../data/verifiedScholarships.ts';
import {
  computeTrackerOverviewCounts,
  evaluateTrackedApplication,
  normalizeApplicationStatus,
} from '../lib/applicationTrackerEngine.ts';
import { compareDocumentsAgainstScholarship } from '../lib/documentComparison.ts';
import {
  computeProfileCompleteness,
  evaluateDeterministicEligibility,
  isScholarshipSourceVerified,
} from '../lib/eligibilityEngine.ts';
import { evaluateScholarshipReadiness } from '../lib/readinessEngine.ts';
import { evaluateTrustGuardVerification } from '../lib/trustguardEngine.ts';
import type {
  ApplicationChecklistItemRecord,
  ApplicationEventRecord,
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  EligibilityAssessment,
  NotificationRecord,
  ReadinessAssessment,
  SavedScholarship,
  Scholarship,
  StudentProfile,
  TrustGuardDocumentAssessment,
} from '../types/database.ts';

export class CompanionError extends Error {
  httpStatus: number;
  code: string;

  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.name = 'CompanionError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

const SERVER_APP_NAME = 'grantly-companion-server-db';

function getServerFirestoreDb() {
  const existing = getApps().find((a) => a.name === SERVER_APP_NAME);
  const app = existing ?? initializeApp(firebaseConfig, SERVER_APP_NAME);
  return getFirestore(app, firebaseConfig.firestoreDatabaseId);
}

export async function fetchLiveScholarshipsFromDb(): Promise<Scholarship[]> {
  try {
    const db = getServerFirestoreDb();
    const snap = await getDocs(collection(db, 'scholarships'));
    if (snap.empty) return [];
    const firestoreItems = snap.docs.map((d) => d.data() as Scholarship);
    return mergeCatalogWithVerifiedAdditions(firestoreItems);
  } catch (err) {
    console.error('Failed to read live scholarships collection:', err);
    throw new CompanionError(
      503,
      'DB_READ_FAILED',
      'Unable to retrieve the scholarship database right now. Please try again shortly.'
    );
  }
}

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
    const fields = val.mapValue?.fields ?? {};
    for (const [k, v] of Object.entries(fields)) {
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

async function fetchUserProfileRest(
  uid: string,
  idToken: string
): Promise<{ ok: boolean; profile: StudentProfile | null }> {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/profiles/${encodeURIComponent(uid)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404) {
      return { ok: true, profile: null };
    }
    if (!res.ok) {
      return { ok: false, profile: null };
    }
    const json = (await res.json()) as { fields?: Record<string, FirestoreValue> };
    const decoded = decodeFirestoreDocument<StudentProfile>(json.fields);
    if (decoded && decoded.uid !== uid) {
      return { ok: false, profile: null };
    }
    return { ok: true, profile: decoded };
  } catch {
    return { ok: false, profile: null };
  }
}

async function queryUserCollectionRest<T extends { userId?: string }>(
  collectionId: string,
  uid: string,
  idToken: string
): Promise<{ ok: boolean; items: T[] }> {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents:runQuery`;
  try {
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
          limit: 50,
        },
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { ok: false, items: [] };
    }
    const rows = (await res.json()) as Array<{ document?: { fields?: Record<string, FirestoreValue> } }>;
    const items: T[] = [];
    for (const row of rows) {
      const decoded = decodeFirestoreDocument<T>(row.document?.fields);
      if (decoded && (!decoded.userId || decoded.userId === uid)) {
        items.push(decoded);
      }
    }
    return { ok: true, items };
  } catch {
    return { ok: false, items: [] };
  }
}

export interface StudentDatabaseSnapshot {
  profile: StudentProfile | null;
  documents: DocumentRecord[];
  documentAnalyses: DocumentAnalysis[];
  eligibilityAssessments: EligibilityAssessment[];
  savedScholarships: SavedScholarship[];
  applications: ApplicationRecord[];
  applicationEvents?: ApplicationEventRecord[];
  applicationChecklistItems?: ApplicationChecklistItemRecord[];
  readinessAssessments: ReadinessAssessment[];
  trustGuardAssessments?: TrustGuardDocumentAssessment[];
  notifications: NotificationRecord[];
  sourceMode: 'server-firestore-rest' | 'verified-client-snapshot' | 'hybrid';
}

export interface ClientCompanionContextPayload {
  profileContext?: Record<string, unknown> | null;
  documentContext?: Array<Record<string, unknown>>;
  studentContext?: {
    profile?: Record<string, unknown> | null;
    documents?: Array<Record<string, unknown>>;
    documentAnalyses?: Array<Record<string, unknown>>;
    eligibilityAssessments?: Array<Record<string, unknown>>;
    savedScholarships?: Array<Record<string, unknown>>;
    applications?: Array<Record<string, unknown>>;
    applicationEvents?: Array<Record<string, unknown>>;
    applicationChecklistItems?: Array<Record<string, unknown>>;
    readinessAssessments?: Array<Record<string, unknown>>;
    trustGuardAssessments?: Array<Record<string, unknown>>;
    notifications?: Array<Record<string, unknown>>;
  };
}

function assertRecordOwnership(
  record: Record<string, unknown> | null | undefined,
  authUid: string,
  fieldLabel: string
): void {
  if (!record) return;
  const uidVal = typeof record.uid === 'string' ? record.uid : undefined;
  const userIdVal = typeof record.userId === 'string' ? record.userId : undefined;
  if (uidVal && uidVal !== authUid) {
    throw new CompanionError(
      403,
      'CROSS_STUDENT_FORBIDDEN',
      `Access denied: ${fieldLabel} belongs to another student account.`
    );
  }
  if (userIdVal && userIdVal !== authUid) {
    throw new CompanionError(
      403,
      'CROSS_STUDENT_FORBIDDEN',
      `Access denied: ${fieldLabel} belongs to another student account.`
    );
  }
}

function assertArrayOwnership<T>(
  items: Array<Record<string, unknown>> | undefined,
  authUid: string,
  label: string
): T[] {
  if (!items || !Array.isArray(items)) return [];
  for (const item of items) {
    assertRecordOwnership(item, authUid, label);
  }
  return items as unknown as T[];
}

export function validateAndExtractClientSnapshot(
  authUid: string,
  payload: ClientCompanionContextPayload
): Omit<StudentDatabaseSnapshot, 'sourceMode'> {
  const sc = payload.studentContext;

  const rawProfile = (sc?.profile ?? payload.profileContext ?? null) as Record<
    string,
    unknown
  > | null;
  assertRecordOwnership(rawProfile, authUid, 'profileContext');

  const rawDocs = (sc?.documents ?? []) as Array<Record<string, unknown>>;
  const documents = assertArrayOwnership<DocumentRecord>(rawDocs, authUid, 'documents');

  const rawAnalyses = (sc?.documentAnalyses ?? []) as Array<Record<string, unknown>>;
  const documentAnalyses = assertArrayOwnership<DocumentAnalysis>(
    rawAnalyses,
    authUid,
    'documentAnalyses'
  );

  // Back-compat: support compact documentContext if full documents/analyses weren't passed
  if (documents.length === 0 && payload.documentContext && payload.documentContext.length > 0) {
    assertArrayOwnership(payload.documentContext, authUid, 'documentContext');
    payload.documentContext.forEach((dc, idx) => {
      const docId = typeof dc.id === 'string' ? dc.id : `doc-ctx-${idx}`;
      const docType = typeof dc.documentType === 'string' ? dc.documentType : 'Document';
      const fileName = typeof dc.fileName === 'string' ? dc.fileName : 'Uploaded File';
      const status = typeof dc.processingStatus === 'string' ? dc.processingStatus : 'Completed';
      const now = new Date().toISOString();
      documents.push({
        id: docId,
        userId: authUid,
        documentType: docType,
        fileName,
        storagePath: 'private-vault',
        verificationStatus: status === 'Completed' ? 'Analyzed' : 'Needs Attention',
        processingStatus:
          status === 'Completed' || status === 'Needs Review' || status === 'Failed' || status === 'Pending' || status === 'Processing'
            ? status
            : 'Completed',
        createdAt: now,
        updatedAt: now,
      });
      documentAnalyses.push({
        id: `ana-ctx-${idx}`,
        userId: authUid,
        documentId: docId,
        detectedType: typeof dc.detectedType === 'string' ? dc.detectedType : docType,
        readabilityStatus: 'Readable',
        issuingAuthority: typeof dc.issuingAuthority === 'string' ? dc.issuingAuthority : undefined,
        extractedFields: Array.isArray(dc.extractedFields)
          ? (dc.extractedFields as DocumentAnalysis['extractedFields'])
          : [],
        marksheetSummary: (dc.marksheetSummary as DocumentAnalysis['marksheetSummary']) ?? undefined,
        missingFields: Array.isArray(dc.missingFields) ? (dc.missingFields as string[]) : undefined,
        issuesFound: Array.isArray(dc.issuesFound) ? (dc.issuesFound as string[]) : undefined,
        readinessVerdict:
          dc.readinessVerdict === 'Ready' ||
          dc.readinessVerdict === 'Needs Clarification' ||
          dc.readinessVerdict === 'Incomplete'
            ? dc.readinessVerdict
            : 'Needs Clarification',
        createdAt: now,
      });
    });
  }

  return {
    profile: rawProfile as unknown as StudentProfile | null,
    documents,
    documentAnalyses,
    eligibilityAssessments: assertArrayOwnership<EligibilityAssessment>(
      sc?.eligibilityAssessments,
      authUid,
      'eligibilityAssessments'
    ),
    savedScholarships: assertArrayOwnership<SavedScholarship>(
      sc?.savedScholarships,
      authUid,
      'savedScholarships'
    ),
    applications: assertArrayOwnership<ApplicationRecord>(
      sc?.applications,
      authUid,
      'applications'
    ),
    applicationEvents: assertArrayOwnership<ApplicationEventRecord>(
      sc?.applicationEvents,
      authUid,
      'applicationEvents'
    ),
    applicationChecklistItems: assertArrayOwnership<ApplicationChecklistItemRecord>(
      sc?.applicationChecklistItems,
      authUid,
      'applicationChecklistItems'
    ),
    readinessAssessments: assertArrayOwnership<ReadinessAssessment>(
      sc?.readinessAssessments,
      authUid,
      'readinessAssessments'
    ),
    trustGuardAssessments: assertArrayOwnership<TrustGuardDocumentAssessment>(
      sc?.trustGuardAssessments,
      authUid,
      'trustGuardAssessments'
    ),
    notifications: assertArrayOwnership<NotificationRecord>(
      sc?.notifications,
      authUid,
      'notifications'
    ),
  };
}

export async function resolveAuthenticatedStudentProfile(
  authUid: string,
  idToken: string | undefined,
  clientProfile?: Record<string, unknown> | null
): Promise<StudentProfile | null> {
  assertRecordOwnership(clientProfile ?? null, authUid, 'profile');
  if (idToken) {
    const profRes = await fetchUserProfileRest(authUid, idToken);
    if (profRes.ok) {
      return profRes.profile;
    }
  }
  return clientProfile ? (clientProfile as unknown as StudentProfile) : null;
}

export async function resolveStudentDatabaseSnapshot(
  authUid: string,
  idToken: string | undefined,
  clientPayload: ClientCompanionContextPayload
): Promise<StudentDatabaseSnapshot> {
  // Always validate ownership of any client-supplied records first so spoofing returns 403 immediately
  const validatedClient = validateAndExtractClientSnapshot(authUid, clientPayload);

  if (!idToken) {
    return {
      ...validatedClient,
      sourceMode: 'verified-client-snapshot',
    };
  }

  // Attempt live server-side retrieval via Firestore REST using the student's verified Firebase ID token
  const [
    profRes,
    docsRes,
    anaRes,
    eligRes,
    savedRes,
    appsRes,
    appEventsRes,
    appChecklistRes,
    readyRes,
    tgRes,
    notifRes,
  ] = await Promise.all([
    fetchUserProfileRest(authUid, idToken),
    queryUserCollectionRest<DocumentRecord>('documents', authUid, idToken),
    queryUserCollectionRest<DocumentAnalysis>('document_analysis', authUid, idToken),
    queryUserCollectionRest<EligibilityAssessment>('eligibility_assessments', authUid, idToken),
    queryUserCollectionRest<SavedScholarship>('saved_scholarships', authUid, idToken),
    queryUserCollectionRest<ApplicationRecord>('applications', authUid, idToken),
    queryUserCollectionRest<ApplicationEventRecord>('application_events', authUid, idToken),
    queryUserCollectionRest<ApplicationChecklistItemRecord>('application_checklist_items', authUid, idToken),
    queryUserCollectionRest<ReadinessAssessment>('readiness_assessments', authUid, idToken),
    queryUserCollectionRest<TrustGuardDocumentAssessment>('trustguard_assessments', authUid, idToken),
    queryUserCollectionRest<NotificationRecord>('notifications', authUid, idToken),
  ]);

  const anyRestSuccess =
    profRes.ok || docsRes.ok || eligRes.ok || savedRes.ok || appsRes.ok;

  if (!anyRestSuccess) {
    return {
      ...validatedClient,
      sourceMode: 'verified-client-snapshot',
    };
  }

  const allRestSuccess =
    profRes.ok &&
    docsRes.ok &&
    anaRes.ok &&
    eligRes.ok &&
    savedRes.ok &&
    appsRes.ok &&
    appEventsRes.ok &&
    appChecklistRes.ok &&
    readyRes.ok &&
    tgRes.ok &&
    notifRes.ok;

  return {
    profile: profRes.ok ? profRes.profile : validatedClient.profile,
    documents: docsRes.ok
      ? docsRes.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : validatedClient.documents,
    documentAnalyses: anaRes.ok
      ? anaRes.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : validatedClient.documentAnalyses,
    eligibilityAssessments: eligRes.ok
      ? eligRes.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : validatedClient.eligibilityAssessments,
    savedScholarships: savedRes.ok ? savedRes.items : validatedClient.savedScholarships,
    applications: appsRes.ok
      ? appsRes.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : validatedClient.applications,
    applicationEvents: appEventsRes.ok
      ? appEventsRes.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : (validatedClient.applicationEvents ?? []),
    applicationChecklistItems: appChecklistRes.ok
      ? appChecklistRes.items
      : (validatedClient.applicationChecklistItems ?? []),
    readinessAssessments: readyRes.ok
      ? readyRes.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : validatedClient.readinessAssessments,
    trustGuardAssessments: tgRes.ok
      ? tgRes.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : (validatedClient.trustGuardAssessments ?? []),
    notifications: notifRes.ok
      ? notifRes.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : validatedClient.notifications,
    sourceMode: allRestSuccess ? 'server-firestore-rest' : 'hybrid',
  };
}

export function sanitizeUntrustedText(input: unknown, maxLength = 400): string {
  if (input === null || input === undefined) return '';
  const str = String(input)
    // Strip ASCII control characters except newline/tab
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    // Prevent untrusted text from closing our prompt boundary tags
    .replace(/<\/?\s*UNTRUSTED_[A-Z_]*\s*>/gi, '[TAG_STRIPPED]')
    .replace(/<\/?\s*SYSTEM[A-Z_]*\s*>/gi, '[TAG_STRIPPED]')
    .trim();
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength)}...`;
}

export interface GroundedCompanionStats {
  scholarshipsCount: number;
  eligibleCount: number;
  potentiallyEligibleCount: number;
  notEligibleCount: number;
  documentsCount: number;
  marksheetsCount: number;
  savedCount: number;
  applicationsCount: number;
  profileCompletenessPercent: number;
  readinessPercent: number;
  sourceMode: StudentDatabaseSnapshot['sourceMode'];
}

export interface GroundedCompanionContext {
  scholarshipsEmpty: boolean;
  stats: GroundedCompanionStats;
  serializedContext: string;
}

function tokenizeQuery(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !['the', 'and', 'for', 'with', 'are', 'what', 'which', 'how', 'can', 'why'].includes(t));
}

export function buildGroundedCompanionContext(params: {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  scholarships: Scholarship[];
  snapshot: StudentDatabaseSnapshot;
}): GroundedCompanionContext {
  const { message, history, scholarships, snapshot } = params;
  const {
    profile,
    documents,
    documentAnalyses,
    eligibilityAssessments,
    savedScholarships,
    applications,
    applicationEvents = [],
    applicationChecklistItems = [],
    readinessAssessments,
    trustGuardAssessments = [],
    notifications,
    sourceMode,
  } = snapshot;

  const profileCompleteness = computeProfileCompleteness(profile);

  // Minimize PII sent to LLM (omit email/phone)
  const sanitizedProfile = profile
    ? {
        fullName: sanitizeUntrustedText(profile.fullName, 100),
        state: profile.state || null,
        district: sanitizeUntrustedText(profile.district, 80) || null,
        dateOfBirth: profile.dateOfBirth || null,
        gender: profile.gender || null,
        category: profile.category || null,
        disabilityStatus: profile.disabilityStatus || null,
        educationLevel: profile.educationLevel || null,
        courseSpecialization: sanitizeUntrustedText(profile.courseSpecialization, 140) || null,
        institutionName: sanitizeUntrustedText(profile.institutionName, 160) || null,
        collegeLocation: sanitizeUntrustedText(profile.collegeLocation, 120) || null,
        academicYear: sanitizeUntrustedText(profile.academicYear, 40) || null,
        currentSemesterOrYear: sanitizeUntrustedText(profile.currentSemesterOrYear, 40) || null,
        previousMarksPercent:
          typeof profile.previousMarksPercent === 'number' ? profile.previousMarksPercent : null,
        familyAnnualIncomeInr:
          typeof profile.familyAnnualIncomeInr === 'number' ? profile.familyAnnualIncomeInr : null,
        parentOccupation: sanitizeUntrustedText(profile.parentOccupation, 100) || null,
        hostelStatus: profile.hostelStatus || null,
        declaredCertificates: (profile.certificates ?? []).slice(0, 15),
        onboardingCompleted: Boolean(profile.onboardingCompleted),
      }
    : null;

  // Map latest analysis per document
  const latestAnalysisByDoc = new Map<string, DocumentAnalysis>();
  for (const ana of documentAnalyses) {
    const existing = latestAnalysisByDoc.get(ana.documentId);
    if (!existing || ana.createdAt > existing.createdAt) {
      latestAnalysisByDoc.set(ana.documentId, ana);
    }
  }

  const documentInventory = documents.slice(0, 15).map((doc) => {
    const ana = latestAnalysisByDoc.get(doc.id);
    const ms = ana?.marksheetSummary;
    return {
      documentId: doc.id,
      declaredType: sanitizeUntrustedText(doc.documentType, 100),
      fileName: sanitizeUntrustedText(doc.fileName, 120),
      processingStatus: doc.processingStatus ?? doc.verificationStatus,
      verificationStatus: doc.verificationStatus,
      detectedType: ana ? sanitizeUntrustedText(ana.detectedType, 100) : null,
      readabilityStatus: ana?.readabilityStatus ?? null,
      readinessVerdict: ana?.readinessVerdict ?? null,
      issuingAuthority: ana?.issuingAuthority
        ? sanitizeUntrustedText(ana.issuingAuthority, 120)
        : null,
      expiryWarning: ana?.expiryWarning ? sanitizeUntrustedText(ana.expiryWarning, 200) : null,
      missingFields: (ana?.missingFields ?? []).slice(0, 10).map((f) => sanitizeUntrustedText(f, 80)),
      unreadableFields: (ana?.unreadableFields ?? [])
        .slice(0, 10)
        .map((f) => sanitizeUntrustedText(f, 80)),
      profileMismatches: (ana?.profileMismatches ?? [])
        .slice(0, 10)
        .map((m) => sanitizeUntrustedText(m, 160)),
      issuesFound: (ana?.issuesFound ?? [])
        .slice(0, 8)
        .map((i) => sanitizeUntrustedText(i, 160)),
      recommendations: (ana?.recommendations ?? [])
        .slice(0, 6)
        .map((r) => sanitizeUntrustedText(r, 160)),
      // Keep only non-sensitive extracted fields (mask Aadhaar digits if present)
      extractedFields: (ana?.extractedFields ?? [])
        .filter((f) => f.status === 'Extracted')
        .slice(0, 18)
        .map((f) => {
          const isAadhaarField = f.fieldName.toLowerCase().includes('aadhaar');
          let safeVal = f.value;
          if (isAadhaarField) {
            const digitsCount = (f.value.match(/\d/g) ?? []).length;
            let seenDigits = 0;
            safeVal = f.value.replace(/\d/g, (d) => {
              seenDigits += 1;
              return seenDigits <= Math.max(0, digitsCount - 4) ? 'X' : d;
            });
          }
          return {
            fieldName: sanitizeUntrustedText(f.fieldName, 80),
            value: sanitizeUntrustedText(safeVal, 160),
            confidence: f.confidence,
          };
        }),
      marksheetSummary: ms
        ? {
            boardOrUniversity: sanitizeUntrustedText(ms.boardOrUniversity, 120),
            examinationName: sanitizeUntrustedText(ms.examinationName, 120),
            examClassOrLevel: sanitizeUntrustedText(ms.examClassOrLevel, 80),
            applicableRule: sanitizeUntrustedText(ms.applicableRule, 200),
            hasPrintedOverallAggregate: Boolean(ms.hasPrintedOverallAggregate),
            printedOverallObtainedMarks: ms.printedOverallObtainedMarks ?? null,
            printedOverallMaxMarks: ms.printedOverallMaxMarks ?? null,
            printedOverallPercentage: ms.printedOverallPercentage ?? null,
            requiresUserConfirmation: Boolean(ms.requiresUserConfirmation),
            confirmationStatus: ms.confirmationStatus,
            confirmationReasons: (ms.confirmationReasons ?? [])
              .slice(0, 5)
              .map((r) => sanitizeUntrustedText(r, 160)),
            calculationNotes: (ms.calculationNotes ?? [])
              .slice(0, 6)
              .map((n) => sanitizeUntrustedText(n, 200)),
            mainAggregate: ms.mainAggregate
              ? {
                  label: sanitizeUntrustedText(ms.mainAggregate.label, 120),
                  subjectCount: ms.mainAggregate.subjectCount,
                  obtainedMarks: ms.mainAggregate.obtainedMarks,
                  maximumMarks: ms.mainAggregate.maximumMarks,
                  percentage: ms.mainAggregate.percentage,
                  provenance:
                    ms.mainAggregate.sourceType === 'ai-calculated'
                      ? 'AI-Calculated'
                      : 'Document-Extracted',
                  includedSubjects: ms.mainAggregate.includedSubjects.slice(0, 12),
                }
              : null,
            aggregateIncludingAdditional: ms.aggregateIncludingAdditional
              ? {
                  label: sanitizeUntrustedText(ms.aggregateIncludingAdditional.label, 120),
                  subjectCount: ms.aggregateIncludingAdditional.subjectCount,
                  obtainedMarks: ms.aggregateIncludingAdditional.obtainedMarks,
                  maximumMarks: ms.aggregateIncludingAdditional.maximumMarks,
                  percentage: ms.aggregateIncludingAdditional.percentage,
                  provenance:
                    ms.aggregateIncludingAdditional.sourceType === 'ai-calculated'
                      ? 'AI-Calculated'
                      : 'Document-Extracted',
                  includedSubjects: ms.aggregateIncludingAdditional.includedSubjects.slice(0, 12),
                }
              : null,
            subjects: (ms.subjects ?? []).slice(0, 15).map((sub) => ({
              subjectName: sanitizeUntrustedText(sub.subjectName, 80),
              subjectCategory: sub.subjectCategory,
              theoryMarks: sub.theoryMarks,
              internalOrPracticalMarks: sub.internalOrPracticalMarks,
              printedTotalMarks: sub.printedTotalMarks,
              calculatedTotalMarks: sub.calculatedTotalMarks,
              effectiveTotalMarks: sub.effectiveTotalMarks,
              maxMarks: sub.maxMarks,
              totalSource:
                sub.totalSource === 'ai-calculated' ? 'AI-Calculated' : 'Document-Extracted',
              hasArithmeticDiscrepancy: Boolean(sub.hasArithmeticDiscrepancy),
              discrepancyNote: sub.discrepancyNote
                ? sanitizeUntrustedText(sub.discrepancyNote, 140)
                : undefined,
            })),
          }
        : null,
    };
  });

  const marksheetsCount = documentInventory.filter(
    (d) =>
      d.marksheetSummary !== null ||
      d.declaredType.toLowerCase().includes('marksheet') ||
      (d.detectedType ?? '').toLowerCase().includes('marksheet')
  ).length;

  const savedIdSet = new Set(savedScholarships.map((s) => s.scholarshipId));
  const appByScholarshipId = new Map<string, ApplicationRecord>();
  applications.forEach((a) => appByScholarshipId.set(a.scholarshipId, a));

  const storedAssessmentByScholarship = new Map<string, EligibilityAssessment>();
  for (const ea of eligibilityAssessments) {
    if (!storedAssessmentByScholarship.has(ea.scholarshipId)) {
      storedAssessmentByScholarship.set(ea.scholarshipId, ea);
    }
  }

  const queryTokens = tokenizeQuery(
    `${message} ${history.slice(-4).map((h) => h.content).join(' ')}`
  );

  // Run deterministic eligibility on ALL scholarships in DB so advisor is never stale or blind
  const evaluatedScholarships = scholarships.map((s) => {
    const det = evaluateDeterministicEligibility(profile, s);
    const saved = savedIdSet.has(s.id);
    const app = appByScholarshipId.get(s.id);
    const storedAssessment = storedAssessmentByScholarship.get(s.id);

    const searchable = `${s.title} ${s.provider} ${s.scholarshipType} ${s.description ?? ''}`.toLowerCase();
    const queryHits = queryTokens.reduce(
      (acc, tok) => (searchable.includes(tok) ? acc + 1 : acc),
      0
    );

    let priorityScore = det.compatibilityScore;
    if (queryHits > 0) priorityScore += 60 + queryHits * 15;
    if (app) priorityScore += 35;
    if (saved) priorityScore += 25;
    if (det.overallStatus === 'Eligible') priorityScore += 20;
    else if (det.overallStatus === 'Potentially Eligible') priorityScore += 10;

    return {
      scholarship: s,
      deterministic: det,
      docComparison:
        saved || app || queryHits > 0 || det.overallStatus === 'Eligible' || det.overallStatus === 'Potentially Eligible'
          ? compareDocumentsAgainstScholarship(s, documents, documentAnalyses, profile)
          : null,
      saved,
      application: app ?? null,
      storedAssessment: storedAssessment ?? null,
      priorityScore,
    };
  });

  evaluatedScholarships.sort((a, b) => b.priorityScore - a.priorityScore);

  const eligibleCount = evaluatedScholarships.filter(
    (e) => e.deterministic.overallStatus === 'Eligible'
  ).length;
  const potentiallyEligibleCount = evaluatedScholarships.filter(
    (e) => e.deterministic.overallStatus === 'Potentially Eligible'
  ).length;
  const notEligibleCount = evaluatedScholarships.filter(
    (e) => e.deterministic.overallStatus === 'Not Eligible'
  ).length;

  const readinessReport = evaluateScholarshipReadiness({
    profile,
    documents,
    documentAnalyses,
    eligibilityAssessments,
    savedScholarships,
    applications,
    scholarships,
    previousActions: readinessAssessments[0]?.recommendedActions ?? [],
  });

  const trustGuardEvaluation = evaluateTrustGuardVerification({
    userId: profile?.uid ?? documents[0]?.userId ?? 'student',
    profile,
    documents,
    documentAnalyses,
    scholarships,
    savedScholarships,
    applications,
    previousAssessment: trustGuardAssessments[0] ?? null,
  });

  const schById = new Map(scholarships.map((s) => [s.id, s]));
  const evaluatedTrackedApps = applications.map((app) =>
    evaluateTrackedApplication({
      application: app,
      scholarship: schById.get(app.scholarshipId) ?? null,
      profile,
      documents,
      documentAnalyses,
      trustGuardAssessment: trustGuardEvaluation,
      savedChecklistItems: applicationChecklistItems,
    })
  );
  const trackerOverview = computeTrackerOverviewCounts(evaluatedTrackedApps);

  // Detailed view for top 10 prioritized schemes + compact index of all remaining schemes
  const detailedScholarships = evaluatedScholarships.slice(0, 10).map((item) => {
    const s = item.scholarship;
    return {
      id: s.id,
      title: sanitizeUntrustedText(s.title, 180),
      provider: sanitizeUntrustedText(s.provider, 120),
      scholarshipType: s.scholarshipType,
      verificationStatus: s.verificationStatus,
      isSourceVerified: isScholarshipSourceVerified(s.verificationStatus),
      applicationStatus: item.deterministic.effectiveApplicationStatus,
      applicationDeadline: s.applicationDeadline || 'Check Official Portal',
      officialUrl: s.officialUrl || s.officialSourceUrl || '',
      financialBenefits: sanitizeUntrustedText(
        s.financialBenefitsText || s.benefitsSummary || (s.annualAwardInr ? `₹${s.annualAwardInr}` : ''),
        220
      ),
      rulesSummary: {
        incomeLimitInr: s.incomeLimitInr ?? null,
        minMarksPercent: s.minMarksPercent ?? null,
        educationLevels: s.educationLevels ?? [],
        eligibleCourses: s.eligibleCourses ?? [],
        allowedCategories: s.allowedCategories ?? [],
        eligibleStates: s.eligibleStates ?? ['All India'],
        genderRestriction: s.genderRestriction ?? 'All',
        disabilityRequired: Boolean(s.disabilityRequired),
        requiredDocuments: s.requiredDocuments ?? [],
      },
      deterministicEvaluation: {
        overallStatus: item.deterministic.overallStatus,
        compatibilityScore: item.deterministic.compatibilityScore,
        passedCriteria: item.deterministic.passedCriteria,
        failedCriteria: item.deterministic.failedCriteria,
        unknownCriteria: item.deterministic.unknownCriteria,
        missingProfileFields: item.deterministic.missingProfileFields,
        criteriaDetails: item.deterministic.criteriaBreakdown
          .filter((c) => c.status !== 'Not Applicable')
          .map((c) => ({
            criterion: c.criterion,
            status: c.status,
            detail: sanitizeUntrustedText(c.detail, 200),
          })),
      },
      documentReadiness: item.docComparison
        ? {
            readinessPercent: item.docComparison.readinessPercent,
            missingDocuments: item.docComparison.items
              .filter((i) => i.status === 'Missing')
              .map((i) => i.requiredDocument),
            needsReviewDocuments: item.docComparison.items
              .filter((i) => i.status === 'Needs Review' || i.status === 'Failed')
              .map((i) => ({ doc: i.requiredDocument, notes: i.notes })),
            readyDocuments: item.docComparison.items
              .filter((i) => i.status === 'Ready')
              .map((i) => i.requiredDocument),
          }
        : null,
      studentTracking: {
        isSaved: item.saved,
        applicationStatus: item.application?.status ?? null,
        portalReferenceId: item.application?.portalReferenceId ?? null,
        lastSavedAssessmentAt: item.storedAssessment?.createdAt ?? null,
      },
    };
  });

  const remainingCatalogueOverview = evaluatedScholarships.slice(10).map((item) => ({
    id: item.scholarship.id,
    title: sanitizeUntrustedText(item.scholarship.title, 140),
    provider: sanitizeUntrustedText(item.scholarship.provider, 100),
    verificationStatus: item.scholarship.verificationStatus,
    overallStatus: item.deterministic.overallStatus,
    compatibilityScore: item.deterministic.compatibilityScore,
    failedCriteria: item.deterministic.failedCriteria,
    unknownCriteria: item.deterministic.unknownCriteria,
    officialUrl: item.scholarship.officialUrl || '',
    applicationDeadline: item.scholarship.applicationDeadline || 'Check Official Portal',
  }));

  const contextObject = {
    databaseAvailability: {
      scholarshipsTotalInDatabase: scholarships.length,
      scholarshipsDatabaseEmpty: scholarships.length === 0,
      retrievalSourceMode: sourceMode,
    },
    studentProfile: {
      exists: Boolean(sanitizedProfile),
      completenessPercent: profileCompleteness.percent,
      missingProfileFields: profileCompleteness.missingFields,
      data: sanitizedProfile,
    },
    studentProgress: {
      readinessPercent: readinessReport.readinessPercent,
      documentCoveragePercent: readinessReport.documentCoveragePercent,
      readinessMissingItems: readinessReport.incompleteRequirements.slice(0, 15),
      latestSavedReadinessAt: readinessAssessments[0]?.createdAt ?? null,
      readinessIntelligence: {
        algorithmVersion: readinessReport.algorithmVersion,
        assessmentStatus: readinessReport.assessmentStatus,
        overallScore: readinessReport.overallScore,
        dataAvailabilityWarning: readinessReport.dataAvailabilityWarning ?? null,
        disclaimer: readinessReport.disclaimer,
        dimensionScores: readinessReport.dimensionScores.map((d) => ({
          label: d.label,
          weightPercent: d.weightPercent,
          earnedPoints: d.earnedPoints,
          maxPoints: d.maxPoints,
          scorePercent: d.scorePercent,
          status: d.status,
          summary: d.summary,
          deductionReasons: d.deductionReasons.slice(0, 6),
        })),
        missingProfileFields: readinessReport.missingProfileFields,
        missingDocuments: readinessReport.missingDocuments,
        flaggedDocuments: readinessReport.flaggedDocuments,
        topPrioritizedActions: readinessReport.recommendedActions.slice(0, 10).map((a) => ({
          title: a.title,
          priority: a.priority,
          status: a.status,
          unblocksCount: a.unblocksCount,
          sourceOfRequirement: a.sourceOfRequirement,
          suggestedNextStep: a.suggestedNextStep,
          relatedScholarshipTitle: a.relatedScholarshipTitle ?? null,
        })),
        closestReadyScholarships: readinessReport.scholarshipReadiness
          .filter((s) => s.eligibilityStatus !== 'Not Eligible')
          .slice(0, 6)
          .map((s) => ({
            scholarshipTitle: s.scholarshipTitle,
            eligibilityStatus: s.eligibilityStatus,
            readinessPercent: s.readinessPercent,
            readinessLabel: s.readinessLabel,
            missingDocuments: s.missingDocuments,
            nextRecommendedAction: s.nextRecommendedAction,
            officialUrl: s.officialUrl,
          })),
      },
      trustGuardIntelligence: {
        overallVerificationStatus: trustGuardEvaluation.overallVerificationStatus,
        documentsTotalCount: trustGuardEvaluation.documentsTotalCount,
        documentsAnalyzedCount: trustGuardEvaluation.documentsAnalyzedCount,
        severityCounts: trustGuardEvaluation.severityCounts,
        latestSavedAssessmentAt: trustGuardAssessments[0]?.createdAt ?? null,
        limitationNotice: trustGuardEvaluation.limitationNotice,
        disclaimer: trustGuardEvaluation.disclaimer,
        documentResults: trustGuardEvaluation.documentResults.slice(0, 15).map((dr) => ({
          documentId: dr.documentId,
          fileName: sanitizeUntrustedText(dr.fileName, 120),
          documentType: sanitizeUntrustedText(dr.documentType, 100),
          verificationStatus: dr.verificationStatus,
          highestSeverity: dr.highestSeverity ?? null,
          findingCount: dr.findingCount,
          summaryNote: sanitizeUntrustedText(dr.summaryNote, 180),
        })),
        findings: trustGuardEvaluation.findings.slice(0, 15).map((f) => ({
          findingId: f.findingId,
          category: f.category,
          severity: f.severity,
          title: sanitizeUntrustedText(f.title, 160),
          description: sanitizeUntrustedText(f.description, 260),
          affectedDocuments: f.affectedDocuments.map((ad) => ({
            documentType: sanitizeUntrustedText(ad.documentType, 80),
            fileName: sanitizeUntrustedText(ad.fileName, 120),
          })),
          conflictingValues: f.conflictingValues.slice(0, 4).map((cv) => ({
            sourceLabel: sanitizeUntrustedText(cv.sourceLabel, 100),
            fieldName: sanitizeUntrustedText(cv.fieldName, 80),
            value: sanitizeUntrustedText(cv.value, 160),
          })),
          extractionConfidence: f.extractionConfidence,
          recommendedAction: sanitizeUntrustedText(f.recommendedAction, 200),
          relatedScholarshipTitles: (f.relatedScholarshipTitles ?? []).slice(0, 4),
          reviewStatus: f.reviewStatus,
          studentNote: f.studentNote ? sanitizeUntrustedText(f.studentNote, 160) : null,
          changeState: f.changeState ?? null,
        })),
        correctiveActions: trustGuardEvaluation.correctiveActions
          .slice(0, 8)
          .map((ca) => sanitizeUntrustedText(ca, 200)),
      },
      savedScholarshipCount: savedScholarships.length,
      savedScholarshipIds: savedScholarships.map((s) => s.scholarshipId),
      trackedApplications: applications.slice(0, 15).map((a) => ({
        applicationId: a.id,
        scholarshipId: a.scholarshipId,
        scholarshipTitle: sanitizeUntrustedText(a.scholarshipTitle, 140),
        status: normalizeApplicationStatus(a.status),
        portalReferenceId: sanitizeUntrustedText(a.portalReferenceId, 80) || null,
        deadline: a.deadline || null,
        notes: sanitizeUntrustedText(a.notes, 160) || null,
        updatedAt: a.updatedAt,
      })),
      trackedApplicationIntelligence: {
        overviewCounts: trackerOverview,
        applications: evaluatedTrackedApps.slice(0, 15).map((ev) => ({
          applicationId: ev.application.id,
          scholarshipId: ev.application.scholarshipId,
          scholarshipTitle: sanitizeUntrustedText(ev.application.scholarshipTitle, 140),
          provider: sanitizeUntrustedText(
            ev.scholarship?.provider || ev.application.provider || '',
            100
          ),
          status: ev.normalizedStatus,
          preparationStatus: ev.preparationStatus,
          eligibilityStatus: ev.eligibilityStatus,
          scholarshipMissingOrArchived: ev.scholarshipMissingOrArchived,
          isSourceVerified: ev.isSourceVerified,
          officialUrl: ev.scholarship?.officialUrl || ev.scholarship?.officialSourceUrl || '',
          deadline: {
            state: ev.deadline.state,
            displayLabel: ev.deadline.displayLabel,
            daysRemaining: ev.deadline.daysRemaining,
            isVerifiedDate: ev.deadline.isVerifiedDate,
            isApproaching: ev.deadline.isApproaching,
            isExpired: ev.deadline.isExpired,
          },
          checklist: {
            hasPublishedChecklist: ev.checklist.hasPublishedChecklist,
            totalRequired: ev.checklist.totalRequired,
            readyCount: ev.checklist.readyCount,
            missingCount: ev.checklist.missingCount,
            warningCount: ev.checklist.warningCount,
            needsReviewCount: ev.checklist.needsReviewCount,
            missingDocumentNames: ev.checklist.items
              .filter((i) => i.checklistStatus === 'Missing')
              .map((i) => i.requirementName),
          },
          unresolvedCriticalOrHighFindings: ev.unresolvedCriticalOrHighFindings,
          trustGuardWarnings: ev.trustGuardFindingsForApp.slice(0, 4).map((f) => ({
            severity: f.severity,
            title: sanitizeUntrustedText(f.title, 140),
            recommendedAction: sanitizeUntrustedText(f.recommendedAction, 160),
          })),
          needsAttention: ev.needsAttention,
          attentionReasons: ev.attentionReasons,
          nextRecommendedAction: ev.nextRecommendedAction,
          portalReferenceId: sanitizeUntrustedText(ev.application.portalReferenceId, 80) || null,
          submissionDate: ev.application.submissionDate ?? null,
          submissionConfirmedByStudent: Boolean(ev.application.submissionConfirmedByStudent),
          correctionNotes: sanitizeUntrustedText(ev.application.correctionNotes, 200) || null,
          finalOutcome: sanitizeUntrustedText(ev.application.finalOutcome, 200) || null,
          recentEvents: applicationEvents
            .filter((evt) => evt.applicationId === ev.application.id)
            .slice(0, 5)
            .map((evt) => ({
              eventType: evt.eventType,
              description: sanitizeUntrustedText(evt.description, 160),
              createdAt: evt.createdAt,
            })),
          updatedAt: ev.application.updatedAt,
        })),
      },
      recentNotifications: notifications.slice(0, 5).map((n) => ({
        title: sanitizeUntrustedText(n.title, 100),
        message: sanitizeUntrustedText(n.message, 180),
        category: n.category ?? 'System',
        isRead: n.isRead,
      })),
    },
    uploadedDocumentsAndAnalysis: {
      totalUploadedDocuments: documents.length,
      totalAnalyzedMarksheets: marksheetsCount,
      documents: documentInventory,
    },
    scholarshipCatalogueAndEligibility: {
      summaryCounts: {
        total: scholarships.length,
        eligible: eligibleCount,
        potentiallyEligible: potentiallyEligibleCount,
        notEligible: notEligibleCount,
        insufficientInfoOrUnverified:
          scholarships.length - eligibleCount - potentiallyEligibleCount - notEligibleCount,
      },
      detailedTopMatchesAndRelevantSchemes: detailedScholarships,
      otherCatalogSchemesSummary: remainingCatalogueOverview,
    },
  };

  return {
    scholarshipsEmpty: scholarships.length === 0,
    stats: {
      scholarshipsCount: scholarships.length,
      eligibleCount,
      potentiallyEligibleCount,
      notEligibleCount,
      documentsCount: documents.length,
      marksheetsCount,
      savedCount: savedScholarships.length,
      applicationsCount: applications.length,
      profileCompletenessPercent: profileCompleteness.percent,
      readinessPercent: readinessReport.readinessPercent,
      sourceMode,
    },
    serializedContext: JSON.stringify(contextObject),
  };
}
