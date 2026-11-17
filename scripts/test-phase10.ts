import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildApplicationWorkflowNotification,
  buildDocumentProcessingNotification,
  buildReadinessNotification,
  buildTrustGuardAlertNotification,
  deriveAnnouncementNotifications,
  deriveDeadlineIntelligenceNotifications,
  deriveSmartScholarshipMatchNotifications,
  doesProfileMatchAnnouncementAudience,
  evaluateFullStudentNotifications,
  isAnnouncementActiveAt,
  normalizeNotificationPreferences,
  normalizeNotificationUiCategory,
  pickDeadlineIntervalBucket,
  sanitizeDeadlineIntervals,
} from '../src/lib/notificationEngine.ts';
import { evaluateScholarshipReadiness } from '../src/lib/readinessEngine.ts';
import {
  dispatchNotificationEmailWithRetries,
  getServerEmailProviderConfig,
  type EmailFetchFn,
} from '../src/server/notificationService.ts';
import type {
  AdminAnnouncementRecord,
  ApplicationRecord,
  EligibilityAssessment,
  NotificationDeliveryLogRecord,
  NotificationPreferenceRecord,
  NotificationRecord,
  Scholarship,
  StudentProfile,
} from '../src/types/database.ts';

const NOW_ISO = '2026-06-01T08:00:00.000Z';
const REF_DATE = new Date('2026-06-01T08:00:00.000Z'); // IST: 2026-06-01 13:30

function makeProfile(uid = 'stu-1', overrides: Partial<StudentProfile> = {}): StudentProfile {
  return {
    uid,
    fullName: 'Aarav Sharma',
    email: 'aarav@example.edu',
    state: 'Maharashtra',
    district: 'Pune',
    gender: 'Male',
    category: 'OBC-NCL',
    disabilityStatus: 'None',
    educationLevel: 'Undergraduate (UG)',
    courseSpecialization: 'B.Tech Computer Science',
    institutionName: 'COEP Pune',
    previousMarksPercent: 88,
    familyAnnualIncomeInr: 350000,
    certificates: ['Aadhaar Card', 'Income Certificate (Tehsildar / Competent Authority)'],
    onboardingCompleted: true,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function makeScholarship(id: string, overrides: Partial<Scholarship> = {}): Scholarship {
  return {
    id,
    title: 'Post-Matric OBC Scholarship Maharashtra',
    provider: 'MahaDBT / Social Justice Dept',
    scholarshipType: 'State Government',
    officialUrl: 'https://mahadbt.maharashtra.gov.in',
    officialSourceUrl: 'https://mahadbt.maharashtra.gov.in',
    verificationStatus: 'Verified',
    applicationDeadline: '2026-06-08', // 7 days from 2026-06-01
    applicationStatus: 'Currently accepting applications',
    eligibleStates: ['Maharashtra'],
    educationLevels: ['Undergraduate (UG)'],
    allowedCategories: ['OBC-NCL'],
    incomeLimitInr: 800000,
    minMarksPercent: 60,
    requiredDocuments: ['Income Certificate', 'Domicile Certificate'],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

async function runTests() {
  console.log('--- Phase 10 Notification Intelligence & Automated Alerts Verification ---');

  const profile = makeProfile('stu-1');
  const defaultPrefs = normalizeNotificationPreferences('stu-1', null);

  // 1. Category Normalization & Interval Sanitization
  assert.equal(normalizeNotificationUiCategory('Scholarship'), 'Scholarship');
  assert.equal(normalizeNotificationUiCategory('Deadline'), 'Scholarship');
  assert.equal(normalizeNotificationUiCategory('Eligibility'), 'Scholarship');
  assert.equal(normalizeNotificationUiCategory('Checklist'), 'Application');
  assert.equal(normalizeNotificationUiCategory('TrustGuard'), 'Document');
  assert.equal(normalizeNotificationUiCategory('Readiness'), 'Readiness');
  assert.equal(normalizeNotificationUiCategory('System'), 'Account');
  assert.deepEqual(sanitizeDeadlineIntervals([1, 14, 99, 1, 0]), [14, 1, 0]);
  assert.equal(pickDeadlineIntervalBucket(7, [14, 7, 3, 1, 0]), 7);
  assert.equal(pickDeadlineIntervalBucket(2, [14, 7, 3, 1, 0]), 3);
  assert.equal(pickDeadlineIntervalBucket(10, [14, 7, 3, 1, 0]), 14);
  assert.equal(pickDeadlineIntervalBucket(20, [14, 7, 3, 1, 0]), null);
  console.log('✓ Test 1 passed: Category normalization and deadline interval bucketing');

  // 2. Empty Scholarship Database produces zero fake alerts
  const emptyRes = deriveSmartScholarshipMatchNotifications({
    userId: profile.uid,
    profile,
    scholarships: [],
    existingNotifications: [],
    preferences: defaultPrefs,
    referenceDate: REF_DATE,
  });
  assert.equal(emptyRes.emptyDatabase, true);
  assert.equal(emptyRes.notifications.length, 0);
  console.log('✓ Test 2 passed: Empty scholarship database produces honest empty state & zero fake alerts');

  // 3. Smart Scholarship Matching blocks Unverified & Expired, detects Eligibility Change
  const verifiedMatch = makeScholarship('sch-verified');
  const unverifiedSch = makeScholarship('sch-unverified', {
    title: 'Unverified Scheme',
    verificationStatus: 'Unverified',
  });
  const expiredSch = makeScholarship('sch-expired', {
    title: 'Expired Scheme',
    applicationDeadline: '2026-05-01',
    applicationStatus: 'Expired',
  });
  const priorAssessments: EligibilityAssessment[] = [
    {
      id: 'elig-prev-1',
      userId: profile.uid,
      scholarshipId: verifiedMatch.id,
      overallStatus: 'Potentially Eligible',
      createdAt: '2026-05-20T00:00:00.000Z',
    },
  ];

  const matchRes = deriveSmartScholarshipMatchNotifications({
    userId: profile.uid,
    profile,
    scholarships: [verifiedMatch, unverifiedSch, expiredSch],
    eligibilityAssessments: priorAssessments,
    existingNotifications: [],
    preferences: defaultPrefs,
    referenceDate: REF_DATE,
  });
  assert.equal(matchRes.emptyDatabase, false);
  assert.equal(matchRes.evaluatedCount, 1);
  assert.ok(matchRes.notifications.some((n) => n.subCategory === 'Scholarship Match'));
  assert.ok(matchRes.notifications.some((n) => n.subCategory === 'Eligibility Change'));
  assert.ok(
    matchRes.notifications.every(
      (n) =>
        n.scholarshipId === verifiedMatch.id &&
        n.officialSourceUrl === verifiedMatch.officialSourceUrl &&
        n.verifiedDeadline === verifiedMatch.applicationDeadline
    )
  );
  console.log('✓ Test 3 passed: Smart matching enforces verification/expiry gates & detects eligibility changes');

  // 4. Deadline Intelligence & Deduplication
  const trackedApp: ApplicationRecord = {
    id: 'app-1',
    userId: profile.uid,
    scholarshipId: verifiedMatch.id,
    scholarshipTitle: verifiedMatch.title,
    status: 'Preparing',
    deadline: '2026-06-08', // 7 days away
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
  const submittedApp: ApplicationRecord = {
    id: 'app-2',
    userId: profile.uid,
    scholarshipId: 'sch-sub',
    scholarshipTitle: 'Already Submitted Scheme',
    status: 'Submitted',
    deadline: '2026-06-02', // 1 day away but already submitted
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
  const schSub = makeScholarship('sch-sub', { applicationDeadline: '2026-06-02' });

  const deadlineNotifs1 = deriveDeadlineIntelligenceNotifications({
    userId: profile.uid,
    profile,
    scholarships: [verifiedMatch, schSub],
    applications: [trackedApp, submittedApp],
    savedScholarships: [],
    existingNotifications: [],
    preferences: defaultPrefs,
    referenceDate: REF_DATE,
  });
  assert.equal(deadlineNotifs1.length, 1);
  assert.equal(deadlineNotifs1[0].applicationId, trackedApp.id);
  assert.match(deadlineNotifs1[0].title, /7d/);

  // Re-running with existing notifications yields 0 duplicates
  const deadlineNotifs2 = deriveDeadlineIntelligenceNotifications({
    userId: profile.uid,
    profile,
    scholarships: [verifiedMatch, schSub],
    applications: [trackedApp, submittedApp],
    savedScholarships: [],
    existingNotifications: deadlineNotifs1,
    preferences: defaultPrefs,
    referenceDate: REF_DATE,
  });
  assert.equal(deadlineNotifs2.length, 0);
  console.log('✓ Test 4 passed: Deadline intelligence respects intervals, skips submitted apps, prevents duplicates');

  // 5. Preference Enforcement across Document, Readiness, TrustGuard, and Application builders
  const docComplete = buildDocumentProcessingNotification({
    userId: profile.uid,
    documentId: 'doc-1',
    fileName: 'income_cert.pdf',
    documentType: 'Income Certificate',
    processingStatus: 'Completed',
    preferences: defaultPrefs,
  });
  assert.ok(docComplete && docComplete.category === 'Document');

  const docDisabledPrefs: NotificationPreferenceRecord = {
    ...defaultPrefs,
    documentAlertsEnabled: false,
    missingDocsAlertsEnabled: false,
  };
  assert.equal(
    buildDocumentProcessingNotification({
      userId: profile.uid,
      documentId: 'doc-2',
      fileName: 'failed.pdf',
      documentType: 'Academic Marksheet',
      processingStatus: 'Failed',
      preferences: docDisabledPrefs,
    }),
    null
  );

  const tgAlert = buildTrustGuardAlertNotification({
    userId: profile.uid,
    assessment: {
      dataFingerprint: 'fp-123',
      overallVerificationStatus: 'Information Mismatch Detected',
      severityCounts: { critical: 1, high: 0, medium: 1, low: 0, informational: 0 },
      findings: [
        {
          findingId: 'f1',
          evidenceFingerprint: 'ef1',
          category: 'Income Consistency',
          severity: 'Critical',
          title: 'Income mismatch between certificate and profile',
          description: 'Extracted ₹4.5L vs profile ₹3.5L',
          affectedDocuments: [],
          conflictingValues: [],
          evidenceSource: 'Income Certificate',
          extractionConfidence: 'High',
          recommendedAction: 'Reconcile income values.',
          reviewStatus: 'Unreviewed',
        },
      ],
    },
    preferences: defaultPrefs,
  });
  assert.ok(tgAlert && tgAlert.priority === 'High' && tgAlert.actionRoute === '/trustguard');

  const readinessReport = evaluateScholarshipReadiness({
    profile,
    documents: [],
    documentAnalyses: [],
    eligibilityAssessments: [],
    savedScholarships: [],
    applications: [],
    scholarships: [verifiedMatch],
  });
  const readinessNotif = buildReadinessNotification({
    userId: profile.uid,
    report: readinessReport,
    previousAssessment: {
      id: 'prev-r',
      userId: profile.uid,
      readinessPercent: 30,
      overallScore: 30,
      createdAt: NOW_ISO,
    },
    preferences: defaultPrefs,
  });
  assert.ok(readinessNotif && readinessNotif.category === 'Readiness');

  const appCorrectionNotif = buildApplicationWorkflowNotification({
    userId: profile.uid,
    application: {
      ...trackedApp,
      status: 'Correction Required',
      correctionNotes: 'Re-upload clearer Tehsildar seal',
      lastStatusChangedAt: NOW_ISO,
    },
    previousStatus: 'Under Review',
    preferences: defaultPrefs,
  });
  assert.ok(
    appCorrectionNotif &&
      appCorrectionNotif.category === 'Application' &&
      appCorrectionNotif.priority === 'High' &&
      appCorrectionNotif.message.includes('Tehsildar seal')
  );
  console.log('✓ Test 5 passed: Domain event builders & preference suppression verified');

  // 6. Real Email Provider Transport, Retries, Failure Handling & Unconfigured Honesty
  const unconfiguredStatus = getServerEmailProviderConfig({});
  assert.equal(unconfiguredStatus.configured, false);
  assert.match(unconfiguredStatus.statusLabel, /Not Configured/i);

  const sampleNotif: NotificationRecord = docComplete!;
  const unconfiguredLog = await dispatchNotificationEmailWithRetries({
    userId: profile.uid,
    recipientEmail: profile.email,
    notification: sampleNotif,
    env: {},
  });
  assert.equal(unconfiguredLog.status, 'Not Configured');
  assert.equal(unconfiguredLog.attempts, 0);

  // Mock fetch that returns 503 first, then 200 on retry (Resend)
  let resendCalls = 0;
  const retryFetch: EmailFetchFn = async () => {
    resendCalls += 1;
    if (resendCalls === 1) {
      return new Response('Service Unavailable', { status: 503 });
    }
    return new Response(JSON.stringify({ id: 're_msg_999' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const sentLog = await dispatchNotificationEmailWithRetries({
    userId: profile.uid,
    recipientEmail: profile.email,
    notification: sampleNotif,
    env: { RESEND_API_KEY: 're_test_key_12345' },
    fetchImpl: retryFetch,
    maxRetries: 2,
  });
  assert.equal(sentLog.status, 'Sent');
  assert.equal(sentLog.attempts, 2);
  assert.equal(sentLog.providerMessageId, 're_msg_999');

  // Idempotency prevents duplicate send when Sent log already exists
  let duplicateFetchCalled = false;
  const dedupeLog = await dispatchNotificationEmailWithRetries({
    userId: profile.uid,
    recipientEmail: profile.email,
    notification: sampleNotif,
    existingLogs: [sentLog],
    env: { RESEND_API_KEY: 're_test_key_12345' },
    fetchImpl: async () => {
      duplicateFetchCalled = true;
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(duplicateFetchCalled, false);
  assert.equal(dedupeLog.id, sentLog.id);

  // 400 error fails without retries
  let badReqCalls = 0;
  const failLog: NotificationDeliveryLogRecord = await dispatchNotificationEmailWithRetries({
    userId: profile.uid,
    recipientEmail: profile.email,
    notification: sampleNotif,
    env: { RESEND_API_KEY: 're_test_key_12345' },
    fetchImpl: async () => {
      badReqCalls += 1;
      return new Response('Invalid recipient', { status: 400 });
    },
    maxRetries: 2,
  });
  assert.equal(badReqCalls, 1);
  assert.equal(failLog.status, 'Failed');
  assert.equal(failLog.attempts, 1);
  console.log('✓ Test 6 passed: Email transport handles unconfigured, 503 retry, idempotency & 400 failure honestly');

  // 7. Admin Announcements Scheduling & Audience Filtering
  const mhAnnouncement: AdminAnnouncementRecord = {
    id: 'ann-mh-ug',
    title: 'MahaDBT Aadhaar Seeding Reminder',
    message: 'Students in Maharashtra applying for UG schemes must verify NPCI Aadhaar seeding.',
    category: 'Scholarship',
    targetAudience: 'filtered',
    targetStates: ['Maharashtra'],
    targetEducationLevels: ['Undergraduate (UG)'],
    status: 'Published',
    publishAt: '2026-05-30T00:00:00.000Z',
    expiresAt: '2026-06-30T00:00:00.000Z',
    actionRoute: '/scholarships',
    createdByUid: 'admin-1',
    createdByEmail: 'admin@grantly.in',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
  const draftAnnouncement: AdminAnnouncementRecord = {
    ...mhAnnouncement,
    id: 'ann-draft',
    status: 'Draft',
  };
  const futureAnnouncement: AdminAnnouncementRecord = {
    ...mhAnnouncement,
    id: 'ann-future',
    publishAt: '2026-07-01T00:00:00.000Z',
  };

  assert.equal(isAnnouncementActiveAt(mhAnnouncement, REF_DATE), true);
  assert.equal(isAnnouncementActiveAt(draftAnnouncement, REF_DATE), false);
  assert.equal(isAnnouncementActiveAt(futureAnnouncement, REF_DATE), false);

  const kaProfile = makeProfile('stu-2', { state: 'Karnataka' });
  assert.equal(doesProfileMatchAnnouncementAudience(mhAnnouncement, profile), true);
  assert.equal(doesProfileMatchAnnouncementAudience(mhAnnouncement, kaProfile), false);

  const annNotifsMh = deriveAnnouncementNotifications({
    userId: profile.uid,
    profile,
    announcements: [mhAnnouncement, draftAnnouncement, futureAnnouncement],
    existingNotifications: [],
    preferences: defaultPrefs,
    referenceDate: REF_DATE,
  });
  assert.equal(annNotifsMh.length, 1);
  assert.equal(annNotifsMh[0].announcementId, mhAnnouncement.id);

  const annNotifsKa = deriveAnnouncementNotifications({
    userId: kaProfile.uid,
    profile: kaProfile,
    announcements: [mhAnnouncement],
    existingNotifications: [],
    preferences: defaultPrefs,
    referenceDate: REF_DATE,
  });
  assert.equal(annNotifsKa.length, 0);

  // Full feed orchestrator runs cleanly across all modules
  const fullFeed = evaluateFullStudentNotifications({
    userId: profile.uid,
    profile,
    scholarships: [verifiedMatch],
    applications: [trackedApp],
    savedScholarships: [],
    eligibilityAssessments: priorAssessments,
    announcements: [mhAnnouncement],
    existingNotifications: [],
    preferences: defaultPrefs,
    referenceDate: REF_DATE,
  });
  assert.ok(fullFeed.newNotifications.length >= 4);
  console.log('✓ Test 7 passed: Admin announcements targeting, schedule window & unified evaluation verified');

  // 8. Security Rules & Backend Route Coverage Verification
  const rulesText = await fs.readFile(path.resolve('firestore.rules'), 'utf8');
  assert.ok(rulesText.includes('match /notification_delivery_logs/{logId}'));
  assert.ok(rulesText.includes('match /announcements/{announcementId}'));
  assert.ok(rulesText.includes('match /notification_runs/{runId}'));
  assert.ok(rulesText.includes("resource.data.status == 'Published'"));
  assert.ok(rulesText.includes("['isRead', 'readAt', 'isArchived', 'archivedAt']"));

  const serverText = await fs.readFile(path.resolve('server.ts'), 'utf8');
  assert.ok(serverText.includes("'/api/notifications/sync'"));
  assert.ok(serverText.includes("'/api/notifications/preferences'"));
  assert.ok(serverText.includes("'/api/notifications/:id/action'"));
  assert.ok(serverText.includes("'/api/notifications/delivery-logs'"));
  assert.ok(serverText.includes("'/api/admin/announcements'"));
  assert.ok(serverText.includes("'/api/admin/notifications/run-scheduled'"));
  assert.ok(serverText.includes('startNotificationScheduler()'));
  console.log('✓ Test 8 passed: Firestore rules and server route security contracts verified');

  console.log('ALL PHASE 10 TESTS PASSED.');
}

runTests().catch((err) => {
  console.error('Phase 10 test suite failed:', err);
  process.exit(1);
});
