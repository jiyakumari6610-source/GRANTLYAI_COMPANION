import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../data/verifiedScholarships.ts';
import {
  AICompanionValidationError,
  normalizeRetrievedMessages,
  validateAndBuildAIMessage,
} from './aiMessageUtils.ts';
import {
  auth,
  db,
  fetchFirestoreDocumentViaRest,
  handleFirestoreError,
  isFirestoreOfflineError,
  OperationType,
  recoverFirestoreNetwork,
} from './firebase.ts';
import {
  DEFAULT_PUBLIC_CACHE_TTL_MS,
  DEFAULT_USER_CACHE_TTL_MS,
  getActiveCacheUid,
  getOrFetchPublic,
  getOrFetchUser,
  invalidatePublicCache,
  invalidateUserCache,
  peekPublicCache,
} from './workspaceCache.ts';
import type {
  AdminAnnouncementRecord,
  AIConversation,
  AIMessage,
  ApplicationChecklistItemRecord,
  ApplicationEventRecord,
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  EligibilityAssessment,
  EligibilityAssessmentDetail,
  NotificationDeliveryLogRecord,
  NotificationPreferenceRecord,
  NotificationRecord,
  ReadinessAssessment,
  SavedScholarship,
  Scholarship,
  ScholarshipEligibilityRule,
  ScholarshipRuleVersionRecord,
  StudentProfile,
  TrustGuardDocumentAssessment,
  TrustGuardReport,
} from '../types/database.ts';

export function makeId(prefix = 'rec'): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}`;
}

function stripUndefinedDeep<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out as T;
  }
  return input;
}

async function withFirestoreOfflineRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 2
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isFirestoreOfflineError(error) || attempt >= maxRetries) {
        throw error;
      }
      await recoverFirestoreNetwork();
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

// 1. Profiles
export async function getProfile(uid: string): Promise<StudentProfile | null> {
  return getOrFetchUser(uid, 'profile', async () => {
    try {
      const snap = await withFirestoreOfflineRetry(() => getDoc(doc(db, 'profiles', uid)));
      return snap.exists() ? (snap.data() as StudentProfile) : null;
    } catch (error) {
      if (isFirestoreOfflineError(error) && auth.currentUser?.uid === uid) {
        try {
          const idToken = await auth.currentUser.getIdToken();
          const restResult = await fetchFirestoreDocumentViaRest<StudentProfile>(
            'profiles',
            uid,
            idToken
          );
          return restResult.exists ? restResult.data : null;
        } catch {
          // Fall through to structured Firestore error reporting if REST fallback also fails
        }
      }
      handleFirestoreError(error, OperationType.GET, `profiles/${uid}`);
    }
  });
}

export async function saveProfile(profile: StudentProfile): Promise<void> {
  const path = `profiles/${profile.uid}`;
  try {
    const ref = doc(db, 'profiles', profile.uid);
    const existingSnap = await withFirestoreOfflineRetry(() => getDoc(ref));
    if (existingSnap.exists()) {
      const existingData = existingSnap.data() as Partial<StudentProfile>;
      const payload: StudentProfile = {
        ...profile,
        uid: existingData.uid || profile.uid,
        createdAt: existingData.createdAt || profile.createdAt,
      };
      await setDoc(ref, payload, { merge: true });
    } else {
      await setDoc(ref, profile);
    }
    invalidateUserCache(profile.uid, 'profile');
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

// 2. Scholarships
export async function getScholarships(): Promise<{
  items: Scholarship[];
  isEmptyDatabase: boolean;
  error?: string;
}> {
  return getOrFetchPublic(
    'scholarships',
    async () => {
      try {
        const snap = await withFirestoreOfflineRetry(() => getDocs(collection(db, 'scholarships')));
        if (snap.empty) {
          return { items: [], isEmptyDatabase: true };
        }
        const items = snap.docs.map((d) => d.data() as Scholarship);
        return { items, isEmptyDatabase: false };
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'scholarships');
      }
    },
    DEFAULT_PUBLIC_CACHE_TTL_MS
  );
}

export async function getScholarshipById(id: string): Promise<Scholarship | null> {
  const cachedCatalog = peekPublicCache<{ items: Scholarship[]; isEmptyDatabase: boolean }>('scholarships');
  if (cachedCatalog) {
    const found = cachedCatalog.items.find((item) => item.id === id);
    if (found) return found;
  }

  return getOrFetchPublic(
    `scholarship:${id}`,
    async () => {
      try {
        const snap = await withFirestoreOfflineRetry(() => getDoc(doc(db, 'scholarships', id)));
        return snap.exists() ? (snap.data() as Scholarship) : null;
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `scholarships/${id}`);
      }
    },
    DEFAULT_PUBLIC_CACHE_TTL_MS
  );
}

export async function upsertScholarship(scholarship: Scholarship): Promise<void> {
  try {
    await setDoc(doc(db, 'scholarships', scholarship.id), scholarship);
    invalidatePublicCache('scholarships');
    invalidatePublicCache(`scholarship:${scholarship.id}`);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `scholarships/${scholarship.id}`);
  }
}

export async function deleteScholarship(id: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'scholarships', id));
    invalidatePublicCache('scholarships');
    invalidatePublicCache(`scholarship:${id}`);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `scholarships/${id}`);
  }
}

export async function seedVerifiedScholarships(): Promise<number> {
  try {
    const batch = writeBatch(db);
    VERIFIED_INDIAN_SCHOLARSHIPS.forEach((item) => {
      batch.set(doc(db, 'scholarships', item.id), item);
    });
    await batch.commit();
    invalidatePublicCache('scholarships');
    invalidatePublicCache('scholarship:');
    return VERIFIED_INDIAN_SCHOLARSHIPS.length;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'scholarships');
  }
}

export async function getScholarshipEligibilityRules(
  scholarshipId?: string
): Promise<ScholarshipEligibilityRule[]> {
  const allRules = await getOrFetchPublic(
    'scholarship_eligibility_rules',
    async () => {
      try {
        const snap = await withFirestoreOfflineRetry(() =>
          getDocs(collection(db, 'scholarship_eligibility_rules'))
        );
        return snap.docs.map((d) => d.data() as ScholarshipEligibilityRule);
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'scholarship_eligibility_rules');
      }
    },
    DEFAULT_PUBLIC_CACHE_TTL_MS
  );
  return scholarshipId ? allRules.filter((r) => r.scholarshipId === scholarshipId) : allRules;
}

export async function getScholarshipRuleVersions(
  scholarshipId: string
): Promise<ScholarshipRuleVersionRecord[]> {
  return getOrFetchPublic(
    `scholarship_rule_versions:${scholarshipId}`,
    async () => {
      try {
        const q = query(
          collection(db, 'scholarship_rule_versions'),
          where('scholarshipId', '==', scholarshipId)
        );
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as ScholarshipRuleVersionRecord)
          .sort((a, b) => b.versionNumber - a.versionNumber);
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'scholarship_rule_versions');
      }
    },
    DEFAULT_PUBLIC_CACHE_TTL_MS
  );
}

// 3. Saved Scholarships
export async function getSavedScholarships(userId: string): Promise<SavedScholarship[]> {
  return getOrFetchUser(
    userId,
    'saved_scholarships',
    async () => {
      try {
        const q = query(collection(db, 'saved_scholarships'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs.map((d) => d.data() as SavedScholarship);
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'saved_scholarships');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function toggleSavedScholarship(
  userId: string,
  scholarshipId: string,
  currentlySavedId?: string
): Promise<boolean> {
  try {
    if (currentlySavedId) {
      await deleteDoc(doc(db, 'saved_scholarships', currentlySavedId));
      invalidateUserCache(userId, 'saved_scholarships');
      return false;
    }
    const id = `${userId}_${scholarshipId}`;
    const ref = doc(db, 'saved_scholarships', id);
    const existingSnap = await withFirestoreOfflineRetry(() => getDoc(ref));
    if (existingSnap.exists()) {
      await deleteDoc(ref);
      invalidateUserCache(userId, 'saved_scholarships');
      return false;
    }
    const record: SavedScholarship = {
      id,
      userId,
      scholarshipId,
      createdAt: new Date().toISOString(),
    };
    await setDoc(ref, record);
    invalidateUserCache(userId, 'saved_scholarships');
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'saved_scholarships');
  }
}

// 4. Applications, Events & Checklists
export async function getApplications(userId: string): Promise<ApplicationRecord[]> {
  return getOrFetchUser(
    userId,
    'applications',
    async () => {
      try {
        const q = query(collection(db, 'applications'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as ApplicationRecord)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'applications');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function getApplicationById(id: string): Promise<ApplicationRecord | null> {
  const uid = auth.currentUser?.uid ?? getActiveCacheUid();
  const fetcher = async () => {
    try {
      const snap = await withFirestoreOfflineRetry(() => getDoc(doc(db, 'applications', id)));
      return snap.exists() ? (snap.data() as ApplicationRecord) : null;
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `applications/${id}`);
    }
  };
  if (!uid) return fetcher();
  return getOrFetchUser(uid, `application:${id}`, fetcher, DEFAULT_USER_CACHE_TTL_MS);
}

export async function upsertApplication(appRecord: ApplicationRecord): Promise<void> {
  try {
    const clean = stripUndefinedDeep(appRecord);
    await setDoc(doc(db, 'applications', appRecord.id), clean);
    invalidateUserCache(appRecord.userId, 'applications');
    invalidateUserCache(appRecord.userId, `application:${appRecord.id}`);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `applications/${appRecord.id}`);
  }
}

export async function updateApplicationFields(
  id: string,
  fields: Partial<
    Pick<
      ApplicationRecord,
      | 'status'
      | 'portalReferenceId'
      | 'deadline'
      | 'notes'
      | 'submissionDate'
      | 'submissionConfirmedByStudent'
      | 'submissionConfirmedAt'
      | 'portalOpenedAt'
      | 'finalOutcome'
      | 'correctionNotes'
      | 'lastStatusChangedAt'
    >
  > & { updatedAt: string }
): Promise<void> {
  try {
    const clean = stripUndefinedDeep(fields);
    await updateDoc(doc(db, 'applications', id), clean);
    const uid = auth.currentUser?.uid ?? getActiveCacheUid();
    invalidateUserCache(uid, 'applications');
    invalidateUserCache(uid, `application:${id}`);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `applications/${id}`);
  }
}

export async function deleteApplication(id: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'applications', id));
    const uid = auth.currentUser?.uid ?? getActiveCacheUid();
    invalidateUserCache(uid, 'applications');
    invalidateUserCache(uid, `application:${id}`);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `applications/${id}`);
  }
}

export async function getApplicationEvents(
  userId: string,
  applicationId?: string
): Promise<ApplicationEventRecord[]> {
  const items = await getOrFetchUser(
    userId,
    'application_events',
    async () => {
      try {
        const q = query(collection(db, 'application_events'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as ApplicationEventRecord)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'application_events');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
  return applicationId ? items.filter((item) => item.applicationId === applicationId) : items;
}

export async function addApplicationEvent(event: ApplicationEventRecord): Promise<void> {
  try {
    const clean = stripUndefinedDeep(event);
    await setDoc(doc(db, 'application_events', event.id), clean);
    invalidateUserCache(event.userId, 'application_events');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `application_events/${event.id}`);
  }
}

export async function getApplicationChecklistItems(
  userId: string,
  applicationId?: string
): Promise<ApplicationChecklistItemRecord[]> {
  const items = await getOrFetchUser(
    userId,
    'application_checklist_items',
    async () => {
      try {
        const q = query(
          collection(db, 'application_checklist_items'),
          where('userId', '==', userId)
        );
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs.map((d) => d.data() as ApplicationChecklistItemRecord);
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'application_checklist_items');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
  return applicationId ? items.filter((i) => i.applicationId === applicationId) : items;
}

export async function upsertApplicationChecklistItem(
  item: ApplicationChecklistItemRecord
): Promise<void> {
  try {
    const clean = stripUndefinedDeep(item);
    await setDoc(doc(db, 'application_checklist_items', item.id), clean);
    invalidateUserCache(item.userId, 'application_checklist_items');
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.WRITE,
      `application_checklist_items/${item.id}`
    );
  }
}

// 5. Documents & Document Analysis
export async function getDocuments(userId: string): Promise<DocumentRecord[]> {
  return getOrFetchUser(
    userId,
    'documents',
    async () => {
      try {
        const q = query(collection(db, 'documents'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as DocumentRecord)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'documents');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function createDocumentRecord(record: DocumentRecord): Promise<void> {
  try {
    await setDoc(doc(db, 'documents', record.id), stripUndefinedDeep(record));
    invalidateUserCache(record.userId, 'documents');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `documents/${record.id}`);
  }
}

export async function updateDocumentFields(
  id: string,
  fields: Partial<Omit<DocumentRecord, 'id' | 'userId' | 'createdAt'>> & { updatedAt: string }
): Promise<void> {
  try {
    await updateDoc(doc(db, 'documents', id), stripUndefinedDeep(fields));
    invalidateUserCache(auth.currentUser?.uid ?? getActiveCacheUid(), 'documents');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `documents/${id}`);
  }
}

export async function updateDocumentStatus(
  id: string,
  verificationStatus: DocumentRecord['verificationStatus']
): Promise<void> {
  try {
    await updateDoc(doc(db, 'documents', id), {
      verificationStatus,
      updatedAt: new Date().toISOString(),
    });
    invalidateUserCache(auth.currentUser?.uid ?? getActiveCacheUid(), 'documents');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `documents/${id}`);
  }
}

export async function deleteDocumentRecord(id: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'documents', id));
    invalidateUserCache(auth.currentUser?.uid ?? getActiveCacheUid(), 'documents');
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `documents/${id}`);
  }
}

export async function deleteDocumentWithAnalyses(userId: string, documentId: string): Promise<void> {
  try {
    const q = query(collection(db, 'document_analysis'), where('userId', '==', userId));
    const snap = await withFirestoreOfflineRetry(() => getDocs(q));
    const linked = snap.docs.filter((d) => (d.data() as DocumentAnalysis).documentId === documentId);
    const batch = writeBatch(db);
    linked.forEach((anaDoc) => batch.delete(anaDoc.ref));
    batch.delete(doc(db, 'documents', documentId));
    await batch.commit();
    invalidateUserCache(userId, 'documents');
    invalidateUserCache(userId, 'document_analysis');
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `documents/${documentId}`);
  }
}

export async function getDocumentAnalyses(userId: string): Promise<DocumentAnalysis[]> {
  return getOrFetchUser(
    userId,
    'document_analysis',
    async () => {
      try {
        const q = query(collection(db, 'document_analysis'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as DocumentAnalysis)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'document_analysis');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function saveDocumentAnalysis(analysis: DocumentAnalysis): Promise<void> {
  try {
    await setDoc(doc(db, 'document_analysis', analysis.id), stripUndefinedDeep(analysis));
    invalidateUserCache(analysis.userId, 'document_analysis');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `document_analysis/${analysis.id}`);
  }
}

// 6. Eligibility & Readiness Assessments
export async function getEligibilityAssessments(userId: string): Promise<EligibilityAssessment[]> {
  return getOrFetchUser(
    userId,
    'eligibility_assessments',
    async () => {
      try {
        const q = query(collection(db, 'eligibility_assessments'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as EligibilityAssessment)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'eligibility_assessments');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function saveEligibilityAssessment(item: EligibilityAssessment): Promise<void> {
  try {
    await setDoc(doc(db, 'eligibility_assessments', item.id), item);
    invalidateUserCache(item.userId, 'eligibility_assessments');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `eligibility_assessments/${item.id}`);
  }
}

export async function saveEligibilityAssessmentWithDetails(
  assessment: EligibilityAssessment,
  details: EligibilityAssessmentDetail[]
): Promise<void> {
  try {
    // 1. Write parent assessment document first so security rules on details can verify ownership via get()
    await setDoc(doc(db, 'eligibility_assessments', assessment.id), assessment);

    // 2. Write normalized criterion-level detail documents in a batch
    if (details.length > 0) {
      const batch = writeBatch(db);
      details.forEach((detail) => {
        batch.set(doc(db, 'eligibility_assessment_details', detail.id), detail);
      });
      await batch.commit();
    }
    invalidateUserCache(assessment.userId, 'eligibility_assessments');
    invalidateUserCache(assessment.userId, `eligibility_assessment_details:${assessment.id}`);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `eligibility_assessments/${assessment.id}`);
  }
}

export async function getEligibilityAssessmentDetails(
  userId: string,
  assessmentId: string
): Promise<EligibilityAssessmentDetail[]> {
  return getOrFetchUser(
    userId,
    `eligibility_assessment_details:${assessmentId}`,
    async () => {
      try {
        const q = query(collection(db, 'eligibility_assessment_details'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as EligibilityAssessmentDetail)
          .filter((row) => row.assessmentId === assessmentId);
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'eligibility_assessment_details');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function getReadinessAssessments(userId: string): Promise<ReadinessAssessment[]> {
  return getOrFetchUser(
    userId,
    'readiness_assessments',
    async () => {
      try {
        const q = query(collection(db, 'readiness_assessments'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as ReadinessAssessment)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'readiness_assessments');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function saveReadinessAssessment(item: ReadinessAssessment): Promise<void> {
  try {
    const cleanPayload = stripUndefinedDeep({
      ...item,
      dimensionScores: item.dimensionScores?.slice(0, 10),
      completedRequirements: item.completedRequirements?.slice(0, 60),
      incompleteRequirements: item.incompleteRequirements?.slice(0, 60),
      deductionReasons: item.deductionReasons?.slice(0, 60),
      missingItems: item.missingItems?.slice(0, 60),
      scholarshipReadiness: item.scholarshipReadiness?.slice(0, 40),
      recommendedActions: item.recommendedActions?.slice(0, 40),
    });
    await setDoc(doc(db, 'readiness_assessments', item.id), cleanPayload);
    invalidateUserCache(item.userId, 'readiness_assessments');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `readiness_assessments/${item.id}`);
  }
}

export async function updateReadinessAssessmentActions(
  id: string,
  fields: Pick<ReadinessAssessment, 'recommendedActions' | 'aiActionPlan'> & { updatedAt: string }
): Promise<void> {
  try {
    const cleanFields = stripUndefinedDeep({
      ...fields,
      recommendedActions: fields.recommendedActions?.slice(0, 40),
    });
    await updateDoc(doc(db, 'readiness_assessments', id), cleanFields);
    invalidateUserCache(auth.currentUser?.uid ?? getActiveCacheUid(), 'readiness_assessments');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `readiness_assessments/${id}`);
  }
}

// 7. AI Conversations & Messages
export async function getConversations(userId: string): Promise<AIConversation[]> {
  return getOrFetchUser(
    userId,
    'ai_conversations',
    async () => {
      try {
        const q = query(collection(db, 'ai_conversations'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as AIConversation)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'ai_conversations');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function createConversation(conv: AIConversation): Promise<void> {
  try {
    const cleanConv: AIConversation = {
      id: conv.id,
      userId: conv.userId,
      title: (typeof conv.title === 'string' ? conv.title.trim() : '').slice(0, 200) || 'Scholarship Guidance Thread',
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    };
    await setDoc(doc(db, 'ai_conversations', cleanConv.id), cleanConv);
    invalidateUserCache(conv.userId, 'ai_conversations');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `ai_conversations/${conv.id}`);
  }
}

export async function getMessages(userId: string, conversationId: string): Promise<AIMessage[]> {
  return getOrFetchUser(
    userId,
    `ai_messages:${conversationId}`,
    async () => {
      try {
        const q = query(
          collection(db, 'ai_messages'),
          where('userId', '==', userId),
          where('conversationId', '==', conversationId),
          orderBy('createdAt', 'asc')
        );
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return normalizeRetrievedMessages(
          snap.docs.map((d) => d.data()),
          conversationId
        );
      } catch {
        // Fallback without composite index if index not yet created
        try {
          const q = query(collection(db, 'ai_messages'), where('userId', '==', userId));
          const snap = await withFirestoreOfflineRetry(() => getDocs(q));
          return normalizeRetrievedMessages(
            snap.docs.map((d) => d.data()),
            conversationId
          );
        } catch (fallbackError) {
          handleFirestoreError(fallbackError, OperationType.LIST, 'ai_messages');
        }
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export interface AIMessagePersistenceAdapter {
  writeMessage: (cleanMsg: AIMessage) => Promise<void>;
  touchConversation: (conversationId: string, updatedAt: string) => Promise<void>;
}

export async function persistAIMessage(
  msg: AIMessage,
  adapter?: AIMessagePersistenceAdapter
): Promise<AIMessage> {
  const cleanMsg = validateAndBuildAIMessage(msg);
  try {
    if (adapter) {
      await adapter.writeMessage(cleanMsg);
      await adapter.touchConversation(cleanMsg.conversationId, cleanMsg.createdAt);
    } else {
      await setDoc(doc(db, 'ai_messages', cleanMsg.id), cleanMsg);
      await updateDoc(doc(db, 'ai_conversations', cleanMsg.conversationId), {
        updatedAt: cleanMsg.createdAt,
      });
    }
    invalidateUserCache(cleanMsg.userId, `ai_messages:${cleanMsg.conversationId}`);
    invalidateUserCache(cleanMsg.userId, 'ai_conversations');
    return cleanMsg;
  } catch (error) {
    if (error instanceof AICompanionValidationError) {
      throw error;
    }
    handleFirestoreError(error, OperationType.CREATE, `ai_messages/${cleanMsg.id}`);
  }
}

export async function addMessage(msg: AIMessage): Promise<void> {
  await persistAIMessage(msg);
}

export async function renameConversation(id: string, title: string): Promise<void> {
  try {
    const cleanTitle = title.trim().slice(0, 180) || 'Scholarship Guidance Thread';
    await updateDoc(doc(db, 'ai_conversations', id), {
      title: cleanTitle,
      updatedAt: new Date().toISOString(),
    });
    invalidateUserCache(auth.currentUser?.uid ?? getActiveCacheUid(), 'ai_conversations');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `ai_conversations/${id}`);
  }
}

export async function deleteConversationWithMessages(
  userId: string,
  conversationId: string
): Promise<void> {
  try {
    const q = query(collection(db, 'ai_messages'), where('userId', '==', userId));
    const snap = await withFirestoreOfflineRetry(() => getDocs(q));
    const linked = snap.docs.filter(
      (d) => (d.data() as AIMessage).conversationId === conversationId
    );
    // Batch delete up to 450 docs per commit
    for (let i = 0; i < linked.length; i += 450) {
      const batch = writeBatch(db);
      linked.slice(i, i + 450).forEach((msgDoc) => batch.delete(msgDoc.ref));
      if (i + 450 >= linked.length) {
        batch.delete(doc(db, 'ai_conversations', conversationId));
      }
      await batch.commit();
    }
    if (linked.length === 0) {
      await deleteDoc(doc(db, 'ai_conversations', conversationId));
    }
    invalidateUserCache(userId, 'ai_conversations');
    invalidateUserCache(userId, `ai_messages:${conversationId}`);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `ai_conversations/${conversationId}`);
  }
}

// 8. TrustGuard Reports
export async function getTrustGuardReports(userId: string, isAdmin: boolean): Promise<TrustGuardReport[]> {
  return getOrFetchUser(
    userId,
    `trustguard_reports:${isAdmin ? 'admin' : 'student'}`,
    async () => {
      try {
        const q = isAdmin
          ? query(collection(db, 'trustguard_reports'))
          : query(collection(db, 'trustguard_reports'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as TrustGuardReport)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'trustguard_reports');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function createTrustGuardReport(report: TrustGuardReport): Promise<void> {
  try {
    await setDoc(doc(db, 'trustguard_reports', report.id), report);
    invalidateUserCache(report.userId, 'trustguard_reports');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `trustguard_reports/${report.id}`);
  }
}

export async function updateTrustGuardReportAdmin(report: TrustGuardReport): Promise<void> {
  try {
    await setDoc(doc(db, 'trustguard_reports', report.id), report);
    invalidateUserCache(auth.currentUser?.uid ?? getActiveCacheUid(), 'trustguard_reports');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `trustguard_reports/${report.id}`);
  }
}

export async function getTrustGuardAssessments(
  userId: string
): Promise<TrustGuardDocumentAssessment[]> {
  return getOrFetchUser(
    userId,
    'trustguard_assessments',
    async () => {
      try {
        const q = query(collection(db, 'trustguard_assessments'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as TrustGuardDocumentAssessment)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'trustguard_assessments');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function saveTrustGuardAssessment(
  item: TrustGuardDocumentAssessment
): Promise<void> {
  try {
    const cleanPayload = stripUndefinedDeep({
      ...item,
      documentResults: item.documentResults.slice(0, 40),
      findings: item.findings.slice(0, 50),
      correctiveActions: item.correctiveActions.slice(0, 20),
      ...(item.aiSummary ? { aiSummary: item.aiSummary.slice(0, 4900) } : {}),
      limitationNotice: item.limitationNotice.slice(0, 780),
      disclaimer: item.disclaimer.slice(0, 580),
    });
    await setDoc(doc(db, 'trustguard_assessments', item.id), cleanPayload);
    invalidateUserCache(item.userId, 'trustguard_assessments');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `trustguard_assessments/${item.id}`);
  }
}

export async function updateTrustGuardAssessmentFindings(
  id: string,
  findings: TrustGuardDocumentAssessment['findings'],
  updatedAt: string
): Promise<void> {
  try {
    const cleanFindings = stripUndefinedDeep(findings.slice(0, 50));
    await updateDoc(doc(db, 'trustguard_assessments', id), {
      findings: cleanFindings,
      updatedAt,
    });
    invalidateUserCache(auth.currentUser?.uid ?? getActiveCacheUid(), 'trustguard_assessments');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `trustguard_assessments/${id}`);
  }
}

// 9. Notifications & Preferences
export async function getNotifications(userId: string): Promise<NotificationRecord[]> {
  return getOrFetchUser(
    userId,
    'notifications',
    async () => {
      try {
        const q = query(collection(db, 'notifications'), where('userId', '==', userId));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as NotificationRecord)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'notifications');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function createNotification(notification: NotificationRecord): Promise<void> {
  try {
    const clean = stripUndefinedDeep(notification);
    await setDoc(doc(db, 'notifications', notification.id), clean);
    invalidateUserCache(notification.userId, 'notifications');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `notifications/${notification.id}`);
  }
}

export async function createNotificationsBatch(notifications: NotificationRecord[]): Promise<void> {
  if (notifications.length === 0) return;
  try {
    for (let i = 0; i < notifications.length; i += 400) {
      const batch = writeBatch(db);
      notifications.slice(i, i + 400).forEach((item) => {
        batch.set(doc(db, 'notifications', item.id), stripUndefinedDeep(item));
      });
      await batch.commit();
    }
    invalidateUserCache(notifications[0]?.userId ?? auth.currentUser?.uid ?? getActiveCacheUid(), 'notifications');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, 'notifications');
  }
}

export async function markNotificationRead(id: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'notifications', id), {
      isRead: true,
      readAt: new Date().toISOString(),
    });
    invalidateUserCache(auth.currentUser?.uid ?? getActiveCacheUid(), 'notifications');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `notifications/${id}`);
  }
}

export async function archiveNotification(id: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await updateDoc(doc(db, 'notifications', id), {
      isRead: true,
      readAt: now,
      isArchived: true,
      archivedAt: now,
    });
    invalidateUserCache(auth.currentUser?.uid ?? getActiveCacheUid(), 'notifications');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `notifications/${id}`);
  }
}

export async function deleteNotification(id: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'notifications', id));
    invalidateUserCache(auth.currentUser?.uid ?? getActiveCacheUid(), 'notifications');
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `notifications/${id}`);
  }
}

export async function markAllNotificationsRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  try {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      ids.slice(i, i + 400).forEach((id) => {
        batch.update(doc(db, 'notifications', id), { isRead: true, readAt: now });
      });
      await batch.commit();
    }
    invalidateUserCache(auth.currentUser?.uid ?? getActiveCacheUid(), 'notifications');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, 'notifications');
  }
}

export async function getPublishedAnnouncements(): Promise<AdminAnnouncementRecord[]> {
  return getOrFetchPublic(
    'announcements',
    async () => {
      try {
        const q = query(collection(db, 'announcements'), where('status', '==', 'Published'));
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as AdminAnnouncementRecord)
          .sort((a, b) => (b.publishedAt || b.updatedAt).localeCompare(a.publishedAt || a.updatedAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'announcements');
      }
    },
    DEFAULT_PUBLIC_CACHE_TTL_MS
  );
}

export async function getNotificationDeliveryLogs(
  userId: string
): Promise<NotificationDeliveryLogRecord[]> {
  return getOrFetchUser(
    userId,
    'notification_delivery_logs',
    async () => {
      try {
        const q = query(
          collection(db, 'notification_delivery_logs'),
          where('userId', '==', userId)
        );
        const snap = await withFirestoreOfflineRetry(() => getDocs(q));
        return snap.docs
          .map((d) => d.data() as NotificationDeliveryLogRecord)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'notification_delivery_logs');
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function getNotificationPreferences(
  uid: string
): Promise<NotificationPreferenceRecord | null> {
  return getOrFetchUser(
    uid,
    'notification_preferences',
    async () => {
      try {
        const snap = await withFirestoreOfflineRetry(() =>
          getDoc(doc(db, 'notification_preferences', uid))
        );
        return snap.exists() ? (snap.data() as NotificationPreferenceRecord) : null;
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `notification_preferences/${uid}`);
      }
    },
    DEFAULT_USER_CACHE_TTL_MS
  );
}

export async function saveNotificationPreferences(
  pref: NotificationPreferenceRecord
): Promise<void> {
  try {
    const clean = stripUndefinedDeep(pref);
    await setDoc(doc(db, 'notification_preferences', pref.uid), clean);
    invalidateUserCache(pref.uid, 'notification_preferences');
    invalidateUserCache(pref.uid, 'api:/api/notifications/preferences');
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `notification_preferences/${pref.uid}`);
  }
}

// 10. Admin Oversight
export async function getAllApplicationsAdmin(): Promise<ApplicationRecord[]> {
  try {
    const snap = await withFirestoreOfflineRetry(() => getDocs(collection(db, 'applications')));
    return snap.docs.map((d) => d.data() as ApplicationRecord);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'applications');
  }
}

export async function getAllProfilesAdmin(): Promise<StudentProfile[]> {
  try {
    const snap = await withFirestoreOfflineRetry(() => getDocs(collection(db, 'profiles')));
    return snap.docs.map((d) => d.data() as StudentProfile);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'profiles');
  }
}
