import {
  evaluateDeadlineIntelligence,
  isActiveApplicationStatus,
  normalizeApplicationStatus,
} from './applicationTrackerEngine.ts';
import {
  evaluateDeterministicEligibility,
  isScholarshipSourceVerified,
  resolveApplicationCycleStatus,
} from './eligibilityEngine.ts';
import type { ReadinessEvaluationReport } from './readinessEngine.ts';
import type {
  AdminAnnouncementRecord,
  ApplicationRecord,
  DocumentAnalysis,
  DocumentProcessingStatus,
  DocumentRecord,
  EligibilityAssessment,
  NotificationCategory,
  NotificationPreferenceRecord,
  NotificationRecord,
  ReadinessAssessment,
  SavedScholarship,
  Scholarship,
  StudentProfile,
  TrustGuardDocumentAssessment,
} from '../types/database.ts';

export const DEFAULT_DEADLINE_INTERVALS_DAYS = [7, 3, 1, 0];
export const ALLOWED_DEADLINE_INTERVALS = [14, 7, 3, 1, 0] as const;

export type CanonicalNotificationBucket =
  | 'Scholarship'
  | 'Application'
  | 'Document'
  | 'Readiness'
  | 'Account';

export function normalizeNotificationUiCategory(
  category?: NotificationCategory | string
): CanonicalNotificationBucket {
  switch (category) {
    case 'Scholarship':
    case 'Deadline':
    case 'Eligibility':
      return 'Scholarship';
    case 'Application':
    case 'Checklist':
      return 'Application';
    case 'Document':
    case 'TrustGuard':
      return 'Document';
    case 'Readiness':
      return 'Readiness';
    case 'Account':
    case 'System':
    default:
      return 'Account';
  }
}

export function sanitizeDeadlineIntervals(input?: number[] | null): number[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [...DEFAULT_DEADLINE_INTERVALS_DAYS];
  }
  const allowed = new Set<number>(ALLOWED_DEADLINE_INTERVALS);
  const filtered = Array.from(
    new Set(input.map((n) => Number(n)).filter((n) => Number.isInteger(n) && allowed.has(n)))
  ).sort((a, b) => b - a);
  return filtered.length > 0 ? filtered : [...DEFAULT_DEADLINE_INTERVALS_DAYS];
}

export function normalizeNotificationPreferences(
  uid: string,
  existing?: Partial<NotificationPreferenceRecord> | null,
  emailProviderStatusLabel = 'Not Configured (Requires SMTP/Email Provider)'
): NotificationPreferenceRecord {
  const applicationAlertsEnabled =
    existing?.applicationAlertsEnabled ?? existing?.statusChangeAlertsEnabled ?? true;
  const documentAlertsEnabled =
    existing?.documentAlertsEnabled ?? existing?.missingDocsAlertsEnabled ?? true;
  const emailEnabled =
    existing?.emailNotificationsEnabled ?? existing?.emailDigestRequested ?? false;

  return {
    uid,
    scholarshipAlertsEnabled: existing?.scholarshipAlertsEnabled ?? true,
    applicationAlertsEnabled,
    documentAlertsEnabled,
    readinessAlertsEnabled: existing?.readinessAlertsEnabled ?? true,
    accountSecurityAlertsEnabled: existing?.accountSecurityAlertsEnabled ?? true,
    deadlineRemindersEnabled: existing?.deadlineRemindersEnabled ?? true,
    deadlineIntervalsDays: sanitizeDeadlineIntervals(existing?.deadlineIntervalsDays),
    missingDocsAlertsEnabled: documentAlertsEnabled,
    statusChangeAlertsEnabled: applicationAlertsEnabled,
    emailDigestRequested: emailEnabled,
    emailNotificationsEnabled: emailEnabled,
    emailDeliveryStatus: emailProviderStatusLabel,
    updatedAt: existing?.updatedAt || new Date().toISOString(),
  };
}

function makeNotifId(dedupeKey: string): string {
  const slug = dedupeKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 82);
  const rand = Math.random().toString(36).slice(2, 6);
  return `notif-${slug}-${Date.now().toString(36)}-${rand}`;
}

export function buildNotificationDraft(params: {
  userId: string;
  dedupeKey: string;
  title: string;
  message: string;
  category: NotificationCategory;
  subCategory?: string;
  priority?: 'High' | 'Medium' | 'Low';
  applicationId?: string;
  scholarshipId?: string;
  documentId?: string;
  announcementId?: string;
  officialSourceUrl?: string;
  verifiedDeadline?: string;
  actionRoute?: string;
  emailRequested?: boolean;
  emailConfigured?: boolean;
  nowIso?: string;
}): NotificationRecord {
  const nowIso = params.nowIso ?? new Date().toISOString();
  let deliveryChannel: NotificationRecord['deliveryChannel'] = 'in-app';
  let deliveryStatus: NotificationRecord['deliveryStatus'] = 'Delivered In-App';

  if (params.emailRequested) {
    if (params.emailConfigured) {
      deliveryChannel = 'in-app+email';
      deliveryStatus = 'Email Pending';
    } else {
      deliveryChannel = 'in-app';
      deliveryStatus = 'Email Not Configured';
    }
  }

  return {
    id: makeNotifId(params.dedupeKey),
    userId: params.userId,
    title: params.title.slice(0, 195),
    message: params.message.slice(0, 595),
    category: params.category,
    ...(params.subCategory ? { subCategory: params.subCategory.slice(0, 75) } : {}),
    priority: params.priority ?? 'Medium',
    ...(params.applicationId ? { applicationId: params.applicationId } : {}),
    ...(params.scholarshipId ? { scholarshipId: params.scholarshipId } : {}),
    ...(params.documentId ? { documentId: params.documentId } : {}),
    ...(params.announcementId ? { announcementId: params.announcementId } : {}),
    ...(params.officialSourceUrl
      ? { officialSourceUrl: params.officialSourceUrl.slice(0, 495) }
      : {}),
    ...(params.verifiedDeadline
      ? { verifiedDeadline: params.verifiedDeadline.slice(0, 38) }
      : {}),
    ...(params.actionRoute ? { actionRoute: params.actionRoute.slice(0, 195) } : {}),
    dedupeKey: params.dedupeKey.slice(0, 195),
    deliveryChannel,
    deliveryStatus,
    isRead: false,
    isArchived: false,
    createdAt: nowIso,
  };
}

// ============================================================================
// Module 2: Smart Scholarship Matching Alerts
// ============================================================================

export function deriveSmartScholarshipMatchNotifications(params: {
  userId: string;
  profile: StudentProfile | null;
  scholarships: Scholarship[];
  eligibilityAssessments?: EligibilityAssessment[];
  existingNotifications: NotificationRecord[];
  preferences: NotificationPreferenceRecord;
  emailConfigured?: boolean;
  referenceDate?: Date;
}): {
  notifications: NotificationRecord[];
  emptyDatabase: boolean;
  evaluatedCount: number;
} {
  const {
    userId,
    profile,
    scholarships,
    eligibilityAssessments = [],
    existingNotifications,
    preferences,
    emailConfigured = false,
    referenceDate = new Date(),
  } = params;

  if (scholarships.length === 0) {
    return { notifications: [], emptyDatabase: true, evaluatedCount: 0 };
  }

  if (!preferences.scholarshipAlertsEnabled || !profile || !profile.onboardingCompleted) {
    return { notifications: [], emptyDatabase: false, evaluatedCount: 0 };
  }

  const nowIso = referenceDate.toISOString();
  const existingKeys = new Set(
    existingNotifications.map((n) => n.dedupeKey).filter((k): k is string => Boolean(k))
  );

  // Latest saved assessment status per scholarship to detect real eligibility changes
  const latestAssessByScholarship = new Map<string, EligibilityAssessment>();
  for (const a of [...eligibilityAssessments].sort((x, y) =>
    y.createdAt.localeCompare(x.createdAt)
  )) {
    if (!latestAssessByScholarship.has(a.scholarshipId)) {
      latestAssessByScholarship.set(a.scholarshipId, a);
    }
  }

  const generated: NotificationRecord[] = [];
  let evaluatedCount = 0;

  for (const sch of scholarships) {
    const isVerified = isScholarshipSourceVerified(sch.verificationStatus);
    const cycle = resolveApplicationCycleStatus(sch, referenceDate);

    // Strictly skip unverified, archived, expired, or closed opportunities
    if (!isVerified || cycle === 'Expired' || cycle === 'Closed') {
      continue;
    }

    evaluatedCount += 1;
    const evalResult = evaluateDeterministicEligibility(profile, sch, referenceDate);
    const officialSource = sch.officialSourceUrl || sch.officialUrl;
    const deadlineText = sch.applicationDeadline || 'See official portal';
    const prevAssess = latestAssessByScholarship.get(sch.id);

    // 1. Eligibility status transition alert if student previously evaluated this scheme
    if (prevAssess && prevAssess.overallStatus !== evalResult.overallStatus) {
      const changeKey = `elig-change-${sch.id}-${prevAssess.overallStatus}-to-${evalResult.overallStatus}`;
      if (!existingKeys.has(changeKey)) {
        existingKeys.add(changeKey);
        generated.push(
          buildNotificationDraft({
            userId,
            dedupeKey: changeKey,
            title: `Eligibility updated: ${sch.title}`,
            message: `Your eligibility for ${sch.title} changed from "${prevAssess.overallStatus}" to "${evalResult.overallStatus}" (${evalResult.compatibilityScore}% rule match). Official source: ${officialSource}. Deadline: ${deadlineText}.`,
            category: 'Scholarship',
            subCategory: 'Eligibility Change',
            priority: evalResult.overallStatus === 'Eligible' ? 'High' : 'Medium',
            scholarshipId: sch.id,
            officialSourceUrl: officialSource,
            verifiedDeadline: sch.applicationDeadline,
            actionRoute: `/scholarships/${sch.id}`,
            emailRequested: preferences.emailNotificationsEnabled,
            emailConfigured,
            nowIso,
          })
        );
      }
    }

    // 2. Smart scholarship match / new opportunity alert for Eligible or Potentially Eligible
    if (
      evalResult.overallStatus === 'Eligible' ||
      evalResult.overallStatus === 'Potentially Eligible'
    ) {
      const matchKey = `sch-match-${sch.id}-${evalResult.overallStatus}`;
      if (!existingKeys.has(matchKey)) {
        existingKeys.add(matchKey);
        const topPassed = evalResult.passedCriteria.slice(0, 2).join(', ');
        const gapNote =
          evalResult.overallStatus === 'Potentially Eligible' &&
          evalResult.missingProfileFields.length > 0
            ? ` Complete ${evalResult.missingProfileFields
                .map((f) => f.label)
                .slice(0, 2)
                .join(', ')} to confirm full eligibility.`
            : '';

        generated.push(
          buildNotificationDraft({
            userId,
            dedupeKey: matchKey,
            title:
              evalResult.overallStatus === 'Eligible'
                ? `Scholarship match: ${sch.title}`
                : `Potential match: ${sch.title}`,
            message: `${evalResult.compatibilityScore}% rule match (${evalResult.overallStatus})${
              topPassed ? ` based on ${topPassed}` : ''
            }.${gapNote} Verified source: ${officialSource}. Deadline: ${deadlineText}.`,
            category: 'Scholarship',
            subCategory: 'Scholarship Match',
            priority: evalResult.overallStatus === 'Eligible' ? 'High' : 'Medium',
            scholarshipId: sch.id,
            officialSourceUrl: officialSource,
            verifiedDeadline: sch.applicationDeadline,
            actionRoute: `/scholarships/${sch.id}`,
            emailRequested: preferences.emailNotificationsEnabled,
            emailConfigured,
            nowIso,
          })
        );
      }
    }
  }

  return { notifications: generated, emptyDatabase: false, evaluatedCount };
}

// ============================================================================
// Module 3: Deadline Intelligence (Configurable Intervals, IST, No Duplicates)
// ============================================================================

export function pickDeadlineIntervalBucket(
  daysRemaining: number,
  configuredIntervals: number[]
): number | null {
  if (daysRemaining < 0) return null;
  const sortedAsc = [...sanitizeDeadlineIntervals(configuredIntervals)].sort((a, b) => a - b);
  for (const threshold of sortedAsc) {
    if (daysRemaining <= threshold) {
      return threshold;
    }
  }
  return null;
}

export function deriveDeadlineIntelligenceNotifications(params: {
  userId: string;
  profile: StudentProfile | null;
  scholarships: Scholarship[];
  applications: ApplicationRecord[];
  savedScholarships: SavedScholarship[];
  existingNotifications: NotificationRecord[];
  preferences: NotificationPreferenceRecord;
  emailConfigured?: boolean;
  referenceDate?: Date;
}): NotificationRecord[] {
  const {
    userId,
    profile,
    scholarships,
    applications,
    savedScholarships,
    existingNotifications,
    preferences,
    emailConfigured = false,
    referenceDate = new Date(),
  } = params;

  if (!preferences.deadlineRemindersEnabled || scholarships.length === 0) {
    return [];
  }

  const nowIso = referenceDate.toISOString();
  const intervals = sanitizeDeadlineIntervals(preferences.deadlineIntervalsDays);
  const schMap = new Map(scholarships.map((s) => [s.id, s]));
  const existingKeys = new Set(
    existingNotifications.map((n) => n.dedupeKey).filter((k): k is string => Boolean(k))
  );

  const generated: NotificationRecord[] = [];
  const coveredScholarshipIds = new Set<string>();

  // 1. Evaluate tracked active applications first (highest specificity)
  for (const app of applications) {
    coveredScholarshipIds.add(app.scholarshipId);
    const normalizedStatus = normalizeApplicationStatus(app.status);
    if (
      normalizedStatus === 'Submitted' ||
      normalizedStatus === 'Under Review' ||
      normalizedStatus === 'Approved' ||
      normalizedStatus === 'Rejected' ||
      normalizedStatus === 'Withdrawn' ||
      normalizedStatus === 'Closed'
    ) {
      continue;
    }

    const sch = schMap.get(app.scholarshipId) ?? null;
    const deadlineInfo = evaluateDeadlineIntelligence(sch, app.deadline, referenceDate);

    if (deadlineInfo.isExpired && deadlineInfo.isoDate) {
      const expiredKey = `deadline-expired-${app.id}-${deadlineInfo.isoDate}`;
      if (!existingKeys.has(expiredKey)) {
        existingKeys.add(expiredKey);
        generated.push(
          buildNotificationDraft({
            userId,
            dedupeKey: expiredKey,
            title: `Deadline passed: ${app.scholarshipTitle}`,
            message: deadlineInfo.detail,
            category: 'Scholarship',
            subCategory: 'Deadline Reminder',
            priority: 'High',
            applicationId: app.id,
            scholarshipId: app.scholarshipId,
            officialSourceUrl: sch?.officialSourceUrl || sch?.officialUrl,
            verifiedDeadline: deadlineInfo.isoDate,
            actionRoute: `/applications/${app.id}`,
            emailRequested: preferences.emailNotificationsEnabled,
            emailConfigured,
            nowIso,
          })
        );
      }
      continue;
    }

    if (
      deadlineInfo.isVerifiedDate &&
      !deadlineInfo.isExpired &&
      deadlineInfo.daysRemaining !== null &&
      deadlineInfo.isoDate
    ) {
      const bucket = pickDeadlineIntervalBucket(deadlineInfo.daysRemaining, intervals);
      if (bucket !== null) {
        const intervalKey = `deadline-int-${app.scholarshipId}-${deadlineInfo.isoDate}-d${bucket}`;
        if (!existingKeys.has(intervalKey)) {
          existingKeys.add(intervalKey);
          const dayText =
            deadlineInfo.daysRemaining === 0
              ? 'today (Deadline Day)'
              : `in ${deadlineInfo.daysRemaining} day${deadlineInfo.daysRemaining === 1 ? '' : 's'}`;
          generated.push(
            buildNotificationDraft({
              userId,
              dedupeKey: intervalKey,
              title:
                deadlineInfo.daysRemaining === 0
                  ? `Deadline today: ${app.scholarshipTitle}`
                  : `Deadline in ${deadlineInfo.daysRemaining}d: ${app.scholarshipTitle}`,
              message: `Verified deadline for your "${normalizedStatus}" application is ${dayText} (${deadlineInfo.isoDate} IST). Review checklist and submit on the official portal.`,
              category: 'Scholarship',
              subCategory: 'Deadline Reminder',
              priority: deadlineInfo.daysRemaining <= 1 ? 'High' : 'Medium',
              applicationId: app.id,
              scholarshipId: app.scholarshipId,
              officialSourceUrl: sch?.officialSourceUrl || sch?.officialUrl,
              verifiedDeadline: deadlineInfo.isoDate,
              actionRoute: `/applications/${app.id}`,
              emailRequested: preferences.emailNotificationsEnabled,
              emailConfigured,
              nowIso,
            })
          );
        }
      }
    }
  }

  // 2. Evaluate saved or eligible verified scholarships not yet in active tracker
  const savedSet = new Set(savedScholarships.map((s) => s.scholarshipId));
  for (const sch of scholarships) {
    if (coveredScholarshipIds.has(sch.id)) continue;
    const isSaved = savedSet.has(sch.id);
    if (!isSaved && (!profile || !profile.onboardingCompleted)) continue;

    const deadlineInfo = evaluateDeadlineIntelligence(sch, undefined, referenceDate);
    if (
      !deadlineInfo.isVerifiedDate ||
      deadlineInfo.isExpired ||
      deadlineInfo.daysRemaining === null ||
      !deadlineInfo.isoDate
    ) {
      continue;
    }

    const bucket = pickDeadlineIntervalBucket(deadlineInfo.daysRemaining, intervals);
    if (bucket === null) continue;

    if (!isSaved && profile) {
      const elig = evaluateDeterministicEligibility(profile, sch, referenceDate);
      if (elig.overallStatus !== 'Eligible' && elig.overallStatus !== 'Potentially Eligible') {
        continue;
      }
    }

    const intervalKey = `deadline-int-${sch.id}-${deadlineInfo.isoDate}-d${bucket}`;
    if (!existingKeys.has(intervalKey)) {
      existingKeys.add(intervalKey);
      const dayText =
        deadlineInfo.daysRemaining === 0
          ? 'today (Deadline Day)'
          : `in ${deadlineInfo.daysRemaining} day${deadlineInfo.daysRemaining === 1 ? '' : 's'}`;
      generated.push(
        buildNotificationDraft({
          userId,
          dedupeKey: intervalKey,
          title:
            deadlineInfo.daysRemaining === 0
              ? `Verified deadline today: ${sch.title}`
              : `Upcoming deadline (${deadlineInfo.daysRemaining}d): ${sch.title}`,
          message: `Verified scholarship deadline is ${dayText} (${deadlineInfo.isoDate} IST). Source: ${
            sch.officialSourceUrl || sch.officialUrl
          }.`,
          category: 'Scholarship',
          subCategory: 'Deadline Reminder',
          priority: deadlineInfo.daysRemaining <= 1 ? 'High' : 'Medium',
          scholarshipId: sch.id,
          officialSourceUrl: sch.officialSourceUrl || sch.officialUrl,
          verifiedDeadline: deadlineInfo.isoDate,
          actionRoute: `/scholarships/${sch.id}`,
          emailRequested: preferences.emailNotificationsEnabled,
          emailConfigured,
          nowIso,
        })
      );
    }
  }

  return generated;
}

// ============================================================================
// Module 7: Admin Announcement Audience Evaluation & Delivery
// ============================================================================

export function isAnnouncementActiveAt(
  announcement: AdminAnnouncementRecord,
  referenceDate: Date = new Date()
): boolean {
  if (announcement.status !== 'Published') return false;
  const nowMs = referenceDate.getTime();
  if (announcement.publishAt) {
    const pubMs = Date.parse(announcement.publishAt);
    if (!Number.isNaN(pubMs) && pubMs > nowMs) return false;
  }
  if (announcement.expiresAt) {
    const expMs = Date.parse(announcement.expiresAt);
    if (!Number.isNaN(expMs) && expMs <= nowMs) return false;
  }
  return true;
}

export function doesProfileMatchAnnouncementAudience(
  announcement: AdminAnnouncementRecord,
  profile: StudentProfile | null
): boolean {
  switch (announcement.targetAudience) {
    case 'all':
      return true;
    case 'onboarded':
      return Boolean(profile?.onboardingCompleted);
    case 'pending_onboarding':
      return !profile || !profile.onboardingCompleted;
    case 'filtered': {
      if (!profile) return false;
      const states = announcement.targetStates ?? [];
      const levels = announcement.targetEducationLevels ?? [];
      if (states.length > 0 && (!profile.state || !states.includes(profile.state))) {
        return false;
      }
      if (
        levels.length > 0 &&
        (!profile.educationLevel || !levels.includes(profile.educationLevel))
      ) {
        return false;
      }
      return true;
    }
    default:
      return false;
  }
}

export function deriveAnnouncementNotifications(params: {
  userId: string;
  profile: StudentProfile | null;
  announcements: AdminAnnouncementRecord[];
  existingNotifications: NotificationRecord[];
  preferences: NotificationPreferenceRecord;
  emailConfigured?: boolean;
  referenceDate?: Date;
}): NotificationRecord[] {
  const {
    userId,
    profile,
    announcements,
    existingNotifications,
    preferences,
    emailConfigured = false,
    referenceDate = new Date(),
  } = params;

  const existingKeys = new Set(
    existingNotifications.map((n) => n.dedupeKey).filter((k): k is string => Boolean(k))
  );
  const generated: NotificationRecord[] = [];
  const nowIso = referenceDate.toISOString();

  for (const ann of announcements) {
    if (!isAnnouncementActiveAt(ann, referenceDate)) continue;
    if (!doesProfileMatchAnnouncementAudience(ann, profile)) continue;

    // Account alerts preference does not suppress mandatory maintenance/security notices if category is Maintenance,
    // otherwise respects accountSecurityAlertsEnabled for general announcements
    if (
      ann.category !== 'Maintenance' &&
      preferences.accountSecurityAlertsEnabled === false
    ) {
      continue;
    }

    const dedupeKey = `announcement-${ann.id}`;
    if (existingKeys.has(dedupeKey)) continue;
    existingKeys.add(dedupeKey);

    generated.push(
      buildNotificationDraft({
        userId,
        dedupeKey,
        title: ann.title,
        message: ann.message,
        category: ann.category === 'Scholarship' || ann.category === 'Deadline' ? 'Scholarship' : 'Account',
        subCategory: 'Admin Announcement',
        priority: ann.category === 'Deadline' || ann.category === 'Maintenance' ? 'High' : 'Medium',
        announcementId: ann.id,
        actionRoute: ann.actionRoute || '/notifications',
        emailRequested: preferences.emailNotificationsEnabled,
        emailConfigured,
        nowIso,
      })
    );
  }

  return generated;
}

// ============================================================================
// Module 1 & 9: Domain Event Notification Builders (Document, Readiness, TrustGuard, Application)
// ============================================================================

export function buildDocumentProcessingNotification(params: {
  userId: string;
  documentId: string;
  fileName: string;
  documentType: string;
  processingStatus: DocumentProcessingStatus;
  errorDetails?: string;
  preferences: NotificationPreferenceRecord;
  emailConfigured?: boolean;
  nowIso?: string;
}): NotificationRecord | null {
  if (!(params.preferences.documentAlertsEnabled ?? params.preferences.missingDocsAlertsEnabled)) {
    return null;
  }

  const nowIso = params.nowIso ?? new Date().toISOString();
  const safeName = params.fileName.slice(0, 80);

  if (params.processingStatus === 'Failed') {
    return buildNotificationDraft({
      userId: params.userId,
      dedupeKey: `doc-failed-${params.documentId}-${nowIso.slice(0, 16)}`,
      title: `Document processing failed: ${safeName}`,
      message:
        params.errorDetails?.slice(0, 320) ||
        `Extraction could not complete for ${params.documentType} (${safeName}). Upload a clearer PDF/image or retry analysis.`,
      category: 'Document',
      subCategory: 'Processing Failed',
      priority: 'High',
      documentId: params.documentId,
      actionRoute: '/documents',
      emailRequested: params.preferences.emailNotificationsEnabled,
      emailConfigured: params.emailConfigured,
      nowIso,
    });
  }

  if (params.processingStatus === 'Needs Review') {
    return buildNotificationDraft({
      userId: params.userId,
      dedupeKey: `doc-review-${params.documentId}-${nowIso.slice(0, 16)}`,
      title: `Document needs manual review: ${safeName}`,
      message: `${params.documentType} (${safeName}) finished extraction with items requiring student confirmation (mismatch, unreadable fields, or marksheet selection).`,
      category: 'Document',
      subCategory: 'Manual Review Required',
      priority: 'Medium',
      documentId: params.documentId,
      actionRoute: '/documents',
      emailRequested: params.preferences.emailNotificationsEnabled,
      emailConfigured: params.emailConfigured,
      nowIso,
    });
  }

  if (params.processingStatus === 'Completed') {
    return buildNotificationDraft({
      userId: params.userId,
      dedupeKey: `doc-complete-${params.documentId}-${nowIso.slice(0, 16)}`,
      title: `Document processed: ${safeName}`,
      message: `${params.documentType} (${safeName}) passed automated extraction and is ready for scholarship readiness & TrustGuard checks.`,
      category: 'Document',
      subCategory: 'Processing Completed',
      priority: 'Low',
      documentId: params.documentId,
      actionRoute: '/documents',
      emailRequested: params.preferences.emailNotificationsEnabled,
      emailConfigured: params.emailConfigured,
      nowIso,
    });
  }

  return null;
}

export function buildReadinessNotification(params: {
  userId: string;
  report: ReadinessEvaluationReport;
  previousAssessment?: ReadinessAssessment | null;
  aiPlanUpdated?: boolean;
  preferences: NotificationPreferenceRecord;
  emailConfigured?: boolean;
  nowIso?: string;
}): NotificationRecord | null {
  if (params.preferences.readinessAlertsEnabled === false) {
    return null;
  }

  const { report, previousAssessment, aiPlanUpdated } = params;
  if (report.assessmentStatus === 'No Scholarship Data') {
    return null;
  }

  const nowIso = params.nowIso ?? new Date().toISOString();
  const prevScore = previousAssessment?.overallScore ?? null;
  const newScore = report.overallScore;

  if (aiPlanUpdated) {
    return buildNotificationDraft({
      userId: params.userId,
      dedupeKey: `readiness-plan-${report.dataFingerprint}`,
      title: 'Scholarship action plan updated',
      message: `Your prioritized scholarship action plan was updated (${report.recommendedActions.length} recommended step(s), ${report.missingDocuments.length} missing document(s)).`,
      category: 'Readiness',
      subCategory: 'Action Plan Updated',
      priority: 'Medium',
      actionRoute: '/readiness',
      emailRequested: params.preferences.emailNotificationsEnabled,
      emailConfigured: params.emailConfigured,
      nowIso,
    });
  }

  if (newScore !== null && prevScore !== null && Math.abs(newScore - prevScore) >= 3) {
    const delta = newScore - prevScore;
    const direction = delta > 0 ? `increased by +${delta}` : `changed by ${delta}`;
    return buildNotificationDraft({
      userId: params.userId,
      dedupeKey: `readiness-score-${report.dataFingerprint}`,
      title: `Readiness score updated to ${newScore}%`,
      message: `Your scholarship readiness score ${direction} percentage points (${report.assessmentStatus}). ${
        report.missingDocuments.length > 0
          ? `Important missing documents: ${report.missingDocuments.slice(0, 3).join(', ')}.`
          : 'All core documents reviewed.'
      }`,
      category: 'Readiness',
      subCategory: 'Readiness Updated',
      priority: delta < 0 || report.missingDocuments.length > 0 ? 'High' : 'Medium',
      actionRoute: '/readiness',
      emailRequested: params.preferences.emailNotificationsEnabled,
      emailConfigured: params.emailConfigured,
      nowIso,
    });
  }

  if (report.missingDocuments.length > 0 || report.missingProfileFields.length > 0) {
    return buildNotificationDraft({
      userId: params.userId,
      dedupeKey: `readiness-req-${report.dataFingerprint}`,
      title: 'Important readiness requirements missing',
      message: `${
        report.missingDocuments.length > 0
          ? `Missing docs: ${report.missingDocuments.slice(0, 2).join(', ')}. `
          : ''
      }${
        report.missingProfileFields.length > 0
          ? `Missing profile fields: ${report.missingProfileFields.slice(0, 2).join(', ')}.`
          : ''
      }`.trim(),
      category: 'Readiness',
      subCategory: 'Missing Requirements',
      priority: 'Medium',
      actionRoute: '/readiness',
      emailRequested: params.preferences.emailNotificationsEnabled,
      emailConfigured: params.emailConfigured,
      nowIso,
    });
  }

  return null;
}

export function buildTrustGuardAlertNotification(params: {
  userId: string;
  assessment: Pick<
    TrustGuardDocumentAssessment,
    'dataFingerprint' | 'overallVerificationStatus' | 'severityCounts' | 'findings'
  >;
  preferences: NotificationPreferenceRecord;
  emailConfigured?: boolean;
  nowIso?: string;
}): NotificationRecord | null {
  if (!(params.preferences.documentAlertsEnabled ?? params.preferences.missingDocsAlertsEnabled)) {
    return null;
  }

  const criticalOrHigh =
    params.assessment.severityCounts.critical + params.assessment.severityCounts.high;
  if (criticalOrHigh === 0) return null;

  const topFinding = params.assessment.findings.find(
    (f) => f.severity === 'Critical' || f.severity === 'High'
  );

  return buildNotificationDraft({
    userId: params.userId,
    dedupeKey: `tg-risk-${params.assessment.dataFingerprint}`,
    title: `TrustGuard flagged ${criticalOrHigh} high-priority consistency risk(s)`,
    message:
      topFinding?.title
        ? `${topFinding.title}. ${topFinding.recommendedAction}`
        : 'TrustGuard identified document-to-profile inconsistencies that should be resolved before portal submission.',
    category: 'Document',
    subCategory: 'Consistency Risk',
    priority: 'High',
    actionRoute: '/trustguard',
    emailRequested: params.preferences.emailNotificationsEnabled,
    emailConfigured: params.emailConfigured,
    nowIso: params.nowIso,
  });
}

export function buildApplicationWorkflowNotification(params: {
  userId: string;
  application: ApplicationRecord;
  previousStatus?: string;
  preferences: NotificationPreferenceRecord;
  emailConfigured?: boolean;
  nowIso?: string;
}): NotificationRecord | null {
  if (!(params.preferences.applicationAlertsEnabled ?? params.preferences.statusChangeAlertsEnabled)) {
    return null;
  }

  const { application, previousStatus } = params;
  const st = normalizeApplicationStatus(application.status);
  const nowIso = params.nowIso ?? new Date().toISOString();
  const titleShort = application.scholarshipTitle.slice(0, 75);

  let subCategory = 'Status Changed';
  let title = `Application updated: ${titleShort}`;
  let message = `Status moved from "${previousStatus || 'Created'}" to "${st}".`;
  let priority: 'High' | 'Medium' | 'Low' = 'Medium';

  if (!previousStatus) {
    subCategory = 'Submission Update';
    title = `Application tracked: ${titleShort}`;
    message = `Added "${titleShort}" to your Application Tracker in "${st}" stage.`;
    priority = 'Low';
  } else if (st === 'Correction Required') {
    subCategory = 'Correction Required';
    title = `Correction required: ${titleShort}`;
    message =
      application.correctionNotes?.trim() ||
      'Application requires portal or document corrections. Review TrustGuard and checklist details.';
    priority = 'High';
  } else if (st === 'Approved' || st === 'Rejected') {
    subCategory = 'Outcome Update';
    title = `Application ${st.toLowerCase()}: ${titleShort}`;
    message = application.finalOutcome?.trim() || `Recorded final outcome "${st}" for ${titleShort}.`;
    priority = 'High';
  } else if (st === 'Submitted') {
    subCategory = 'Submission Update';
    title = `Submission recorded: ${titleShort}`;
    message = application.portalReferenceId
      ? `Confirmed student-recorded submission (Ref: ${application.portalReferenceId}).`
      : 'Confirmed student-recorded portal submission. Add your acknowledgement ID when received.';
    priority = 'Medium';
  }

  return buildNotificationDraft({
    userId: params.userId,
    dedupeKey: `app-wf-${application.id}-${st}-${(application.lastStatusChangedAt || nowIso).slice(0, 19)}`,
    title,
    message,
    category: 'Application',
    subCategory,
    priority,
    applicationId: application.id,
    scholarshipId: application.scholarshipId,
    actionRoute: `/applications/${application.id}`,
    emailRequested: params.preferences.emailNotificationsEnabled,
    emailConfigured: params.emailConfigured,
    nowIso,
  });
}

// ============================================================================
// Unified Student Feed Synchronization (Pure Evaluation)
// ============================================================================

export function evaluateFullStudentNotifications(params: {
  userId: string;
  profile: StudentProfile | null;
  scholarships: Scholarship[];
  applications: ApplicationRecord[];
  savedScholarships: SavedScholarship[];
  eligibilityAssessments?: EligibilityAssessment[];
  documents?: DocumentRecord[];
  documentAnalyses?: DocumentAnalysis[];
  announcements?: AdminAnnouncementRecord[];
  existingNotifications: NotificationRecord[];
  preferences: NotificationPreferenceRecord;
  emailConfigured?: boolean;
  referenceDate?: Date;
}): {
  newNotifications: NotificationRecord[];
  emptyScholarshipDatabase: boolean;
  scholarshipsEvaluated: number;
  applicationsEvaluated: number;
} {
  const {
    userId,
    profile,
    scholarships,
    applications,
    savedScholarships,
    eligibilityAssessments = [],
    announcements = [],
    existingNotifications,
    preferences,
    emailConfigured = false,
    referenceDate = new Date(),
  } = params;

  const matchRes = deriveSmartScholarshipMatchNotifications({
    userId,
    profile,
    scholarships,
    eligibilityAssessments,
    existingNotifications,
    preferences,
    emailConfigured,
    referenceDate,
  });

  const combinedSoFar = [...existingNotifications, ...matchRes.notifications];

  const deadlineNotifs = deriveDeadlineIntelligenceNotifications({
    userId,
    profile,
    scholarships,
    applications,
    savedScholarships,
    existingNotifications: combinedSoFar,
    preferences,
    emailConfigured,
    referenceDate,
  });

  const combinedAfterDeadlines = [...combinedSoFar, ...deadlineNotifs];

  const announcementNotifs = deriveAnnouncementNotifications({
    userId,
    profile,
    announcements,
    existingNotifications: combinedAfterDeadlines,
    preferences,
    emailConfigured,
    referenceDate,
  });

  const activeAppsCount = applications.filter((a) => isActiveApplicationStatus(a.status)).length;

  return {
    newNotifications: [...matchRes.notifications, ...deadlineNotifs, ...announcementNotifs],
    emptyScholarshipDatabase: matchRes.emptyDatabase,
    scholarshipsEvaluated: matchRes.evaluatedCount,
    applicationsEvaluated: activeAppsCount,
  };
}
