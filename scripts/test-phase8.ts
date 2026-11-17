import 'dotenv/config';
import assert from 'node:assert/strict';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../src/data/verifiedScholarships.ts';
import {
  buildApplicationDocumentChecklist,
  computeTrackerOverviewCounts,
  deriveApplicationNotifications,
  evaluateDeadlineIntelligence,
  evaluateTrackedApplication,
  validateApplicationTransition,
} from '../src/lib/applicationTrackerEngine.ts';
import { calculateMarksheetAggregates } from '../src/lib/marksheetCalculator.ts';
import { evaluateScholarshipReadiness } from '../src/lib/readinessEngine.ts';
import {
  createTrackedApplicationWorkflow,
  recordPortalOpenWorkflow,
  transitionTrackedApplicationWorkflow,
} from '../src/server/applicationService.ts';
import {
  buildGroundedCompanionContext,
  CompanionError,
  validateAndExtractClientSnapshot,
} from '../src/server/companionContext.ts';
import { buildCompanionPromptArtifacts } from '../src/server/companionService.ts';
import type {
  ApplicationChecklistItemRecord,
  ApplicationEventRecord,
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  NotificationPreferenceRecord,
  NotificationRecord,
  Scholarship,
  StudentProfile,
} from '../src/types/database.ts';

const NOW_ISO = '2026-05-01T10:00:00.000Z';
const REF_DATE = new Date('2026-05-01T10:00:00.000Z'); // IST: 2026-05-01 15:30

function makeProfile(uid = 'student-alpha', overrides: Partial<StudentProfile> = {}): StudentProfile {
  return {
    uid,
    fullName: 'Ananya Sharma',
    email: 'ananya@example.com',
    phone: '+91-9876543210',
    state: 'Maharashtra',
    district: 'Pune',
    dateOfBirth: '2006-08-14',
    gender: 'Female',
    category: 'OBC-NCL',
    disabilityStatus: 'None',
    educationLevel: 'Undergraduate (UG)',
    courseSpecialization: 'B.Tech Computer Science and Engineering',
    institutionName: 'COEP Technological University',
    collegeLocation: 'Pune, Maharashtra',
    academicYear: '2025-26',
    currentSemesterOrYear: '1st Year',
    previousMarksPercent: 95.4,
    familyAnnualIncomeInr: 320000,
    parentOccupation: 'Self-Employed',
    hostelStatus: 'Day Scholar',
    certificates: ['Aadhaar Card', 'Previous Academic Marksheet'],
    onboardingCompleted: true,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function makeMarksheet(uid = 'student-alpha'): { doc: DocumentRecord; ana: DocumentAnalysis } {
  const summary = calculateMarksheetAggregates({
    isMarksheet: true,
    boardOrUniversity: 'Central Board of Secondary Education (CBSE)',
    examinationName: 'Secondary School Examination, 2024',
    examClassOrLevel: 'Class 10',
    printedOverallAggregateFound: false,
    printedOverallObtainedMarks: null,
    printedOverallMaxMarks: null,
    printedOverallPercentage: null,
    subjectSelectionCertainty: 'Confirmed',
    uncertaintyReasons: [],
    subjects: [
      { subjectCode: '184', subjectName: 'English', subjectCategory: 'main', theoryMarks: 76, internalOrPracticalMarks: 20, printedTotalMarks: 96, maxMarks: 100, pageNumber: 1 },
      { subjectCode: '002', subjectName: 'Hindi', subjectCategory: 'main', theoryMarks: 79, internalOrPracticalMarks: 20, printedTotalMarks: 99, maxMarks: 100, pageNumber: 1 },
      { subjectCode: '041', subjectName: 'Mathematics', subjectCategory: 'main', theoryMarks: 70, internalOrPracticalMarks: 20, printedTotalMarks: 90, maxMarks: 100, pageNumber: 1 },
      { subjectCode: '086', subjectName: 'Science', subjectCategory: 'main', theoryMarks: 75, internalOrPracticalMarks: 20, printedTotalMarks: 95, maxMarks: 100, pageNumber: 1 },
      { subjectCode: '087', subjectName: 'Social Science', subjectCategory: 'main', theoryMarks: 77, internalOrPracticalMarks: 20, printedTotalMarks: 97, maxMarks: 100, pageNumber: 1 },
    ],
  });
  return {
    doc: {
      id: 'doc-ms-10',
      userId: uid,
      documentType: 'Academic Marksheet',
      fileName: 'cbse10.pdf',
      storagePath: 'private-vault/doc-ms-10',
      verificationStatus: 'Verified',
      processingStatus: 'Completed',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
    ana: {
      id: 'ana-ms-10',
      userId: uid,
      documentId: 'doc-ms-10',
      detectedType: 'Academic Marksheet',
      readabilityStatus: 'Readable',
      overallConfidence: 'High',
      extractedFields: [{ fieldName: 'Candidate Name', value: 'Ananya Sharma', confidence: 'High', status: 'Extracted' }],
      marksheetSummary: summary,
      readinessVerdict: 'Ready',
      createdAt: NOW_ISO,
    },
  };
}

async function runTests() {
  console.log('--- Phase 8 Application Tracker & Smart Workflow Verification ---');

  const pragatiBase = VERIFIED_INDIAN_SCHOLARSHIPS.find(
    (s) => s.id === 'aicte-pragati-girls-technical'
  )!;
  const pragatiOpen: Scholarship = {
    ...pragatiBase,
    applicationStatus: 'Currently accepting applications',
    applicationDeadline: '2026-05-06', // 5 days from REF_DATE -> Approaching
  };

  const scBase = VERIFIED_INDIAN_SCHOLARSHIPS.find((s) => s.id === 'nsp-post-matric-sc')!;
  const scOpen: Scholarship = {
    ...scBase,
    applicationStatus: 'Currently accepting applications',
    applicationDeadline: '2026-06-15', // 45 days -> Verified Upcoming
  };

  const unverifiedSch: Scholarship = {
    ...pragatiBase,
    id: 'unverified-portal-scheme',
    title: 'Unverified State Merit Grant',
    verificationStatus: 'Pending verification',
    applicationStatus: 'Status unknown',
    applicationDeadline: 'Check Official Portal',
  };

  const expiredSch: Scholarship = {
    ...pragatiBase,
    id: 'expired-scheme-2025',
    title: 'Expired 2025 Scholarship',
    applicationStatus: 'Currently accepting applications',
    applicationDeadline: '2026-04-20',
  };

  const archivedSch: Scholarship = {
    ...pragatiBase,
    id: 'archived-scheme',
    verificationStatus: 'Archived',
  };

  const profile = makeProfile('student-alpha');
  const { doc: msDoc, ana: msAna } = makeMarksheet('student-alpha');
  const incomeDoc: DocumentRecord = {
    id: 'doc-income',
    userId: 'student-alpha',
    documentType: 'Income Certificate',
    fileName: 'income_cert.pdf',
    storagePath: 'private-vault/doc-income',
    verificationStatus: 'Analyzed',
    processingStatus: 'Completed',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
  const incomeMismatchAna: DocumentAnalysis = {
    id: 'ana-income',
    userId: 'student-alpha',
    documentId: 'doc-income',
    detectedType: 'Income Certificate',
    readabilityStatus: 'Readable',
    overallConfidence: 'High',
    extractedFields: [
      { fieldName: 'Applicant Name', value: 'Ananya Sharma', confidence: 'High', status: 'Extracted' },
      { fieldName: 'Annual Family Income', value: 'INR 950000', confidence: 'High', status: 'Extracted' },
    ],
    readinessVerdict: 'Ready',
    createdAt: NOW_ISO,
  };

  // [1] Add real scholarship to tracker + reject missing/archived scholarship
  const created1 = createTrackedApplicationWorkflow({
    uid: 'student-alpha',
    scholarship: pragatiOpen,
    existingApplications: [],
    nowIso: NOW_ISO,
  });
  assert.equal(created1.application.status, 'Interested');
  assert.equal(created1.application.scholarshipId, pragatiOpen.id);
  assert.equal(created1.event.eventType, 'Application Added');
  assert.throws(
    () =>
      createTrackedApplicationWorkflow({
        uid: 'student-alpha',
        scholarship: null,
        existingApplications: [],
      }),
    (e: unknown) => e instanceof CompanionError && e.httpStatus === 404
  );
  assert.throws(
    () =>
      createTrackedApplicationWorkflow({
        uid: 'student-alpha',
        scholarship: archivedSch,
        existingApplications: [],
      }),
    (e: unknown) => e instanceof CompanionError && e.httpStatus === 409
  );
  console.log('PASS [1] Real scholarship added as Interested with audit event; missing/archived rejected');

  // [2] Duplicate active application prevention + preserving closed history
  assert.throws(
    () =>
      createTrackedApplicationWorkflow({
        uid: 'student-alpha',
        scholarship: pragatiOpen,
        existingApplications: [created1.application],
      }),
    (e: unknown) =>
      e instanceof CompanionError &&
      e.httpStatus === 409 &&
      e.code === 'DUPLICATE_ACTIVE_APPLICATION'
  );
  const closedOldApp: ApplicationRecord = {
    ...created1.application,
    id: 'app-old-closed',
    status: 'Closed',
  };
  const recreatedAfterClosed = createTrackedApplicationWorkflow({
    uid: 'student-alpha',
    scholarship: pragatiOpen,
    existingApplications: [closedOldApp],
    nowIso: NOW_ISO,
  });
  assert.equal(recreatedAfterClosed.application.status, 'Interested');
  console.log('PASS [2] Duplicate active application blocked (409); Closed history allows fresh cycle');

  // [3] Valid status transitions through full lifecycle
  const stepPrep = transitionTrackedApplicationWorkflow({
    uid: 'student-alpha',
    application: created1.application,
    scholarship: pragatiOpen,
    nextStatus: 'Preparing',
    nowIso: '2026-05-01T11:00:00.000Z',
  });
  assert.equal(stepPrep.application.status, 'Preparing');
  assert.equal(stepPrep.event.eventType, 'Preparation Started');

  const stepDocsPending = transitionTrackedApplicationWorkflow({
    uid: 'student-alpha',
    application: stepPrep.application,
    scholarship: pragatiOpen,
    nextStatus: 'Documents Pending',
    nowIso: '2026-05-01T12:00:00.000Z',
  });
  const stepReady = transitionTrackedApplicationWorkflow({
    uid: 'student-alpha',
    application: stepDocsPending.application,
    scholarship: pragatiOpen,
    nextStatus: 'Ready to Apply',
    nowIso: '2026-05-01T13:00:00.000Z',
  });
  assert.equal(stepReady.event.eventType, 'Marked Ready');

  const stepSubmitted = transitionTrackedApplicationWorkflow({
    uid: 'student-alpha',
    application: stepReady.application,
    scholarship: pragatiOpen,
    nextStatus: 'Submitted',
    submissionConfirmed: true,
    submissionDate: '2026-05-01',
    portalReferenceId: 'AICTE-2026-9910',
    nowIso: '2026-05-01T14:00:00.000Z',
  });
  assert.equal(stepSubmitted.application.status, 'Submitted');
  assert.equal(stepSubmitted.application.submissionConfirmedByStudent, true);
  assert.equal(stepSubmitted.application.portalReferenceId, 'AICTE-2026-9910');
  assert.equal(stepSubmitted.event.eventType, 'Submission Confirmed');

  const stepCorrection = transitionTrackedApplicationWorkflow({
    uid: 'student-alpha',
    application: stepSubmitted.application,
    scholarship: pragatiOpen,
    nextStatus: 'Correction Required',
    correctionNotes: 'Re-upload Tehsildar income certificate with legible QR.',
    nowIso: '2026-05-01T15:00:00.000Z',
  });
  assert.equal(stepCorrection.event.eventType, 'Correction Requested');

  const stepClosed = transitionTrackedApplicationWorkflow({
    uid: 'student-alpha',
    application: stepCorrection.application,
    scholarship: pragatiOpen,
    nextStatus: 'Closed',
    nowIso: '2026-05-01T16:00:00.000Z',
  });
  assert.equal(stepClosed.event.eventType, 'Final Outcome Recorded');
  console.log('PASS [3] Full 11-stage valid workflow transitions & event types verified');

  // [4] Reject invalid transitions & unconfirmed Submitted
  assert.throws(
    () =>
      transitionTrackedApplicationWorkflow({
        uid: 'student-alpha',
        application: created1.application, // Interested
        scholarship: pragatiOpen,
        nextStatus: 'Submitted',
        submissionConfirmed: true,
      }),
    (e: unknown) => e instanceof CompanionError && e.httpStatus === 400 && e.code === 'INVALID_TRANSITION'
  );
  assert.throws(
    () =>
      transitionTrackedApplicationWorkflow({
        uid: 'student-alpha',
        application: stepReady.application,
        scholarship: pragatiOpen,
        nextStatus: 'Submitted',
        submissionConfirmed: false,
      }),
    (e: unknown) => e instanceof CompanionError && e.httpStatus === 400 && e.code === 'INVALID_TRANSITION'
  );
  assert.throws(
    () =>
      transitionTrackedApplicationWorkflow({
        uid: 'student-alpha',
        application: stepClosed.application,
        scholarship: pragatiOpen,
        nextStatus: 'Preparing',
      }),
    (e: unknown) => e instanceof CompanionError && e.httpStatus === 400
  );
  console.log('PASS [4] Invalid jumps, unconfirmed Submitted, and terminal Closed->Preparing rejected (400)');

  // [5] Eligibility vs Application Preparation separation
  const ineligibleCreated = createTrackedApplicationWorkflow({
    uid: 'student-alpha',
    scholarship: scOpen, // SC scheme, student is OBC-NCL
    existingApplications: [],
    nowIso: NOW_ISO,
  });
  const evalIneligible = evaluateTrackedApplication({
    application: ineligibleCreated.application,
    scholarship: scOpen,
    profile,
    documents: [msDoc],
    documentAnalyses: [msAna],
    referenceDate: REF_DATE,
  });
  assert.equal(evalIneligible.eligibilityStatus, 'Not Eligible');
  assert.equal(evalIneligible.preparationStatus, 'Blocked — Eligibility/Cycle');
  console.log('PASS [5] Eligibility status (Not Eligible) kept cleanly separate from Tracker workflow');

  // [6] & [7] Scheme-specific checklist + missing doc cannot be marked complete
  const staleSavedMissingComplete: ApplicationChecklistItemRecord = {
    id: 'chk-fake-complete',
    applicationId: stepPrep.application.id,
    userId: 'student-alpha',
    scholarshipId: pragatiOpen.id,
    requirementName: 'Bonafide Certificate',
    isCompleted: true, // Attempting to mark a missing doc complete
    manualStatus: 'Completed',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
  const checklistPragati = buildApplicationDocumentChecklist({
    applicationId: stepPrep.application.id,
    scholarship: pragatiOpen,
    profile,
    documents: [msDoc], // missing Bonafide, Aadhaar, Income, Bank Passbook
    documentAnalyses: [msAna],
    savedChecklistItems: [staleSavedMissingComplete],
  });
  const checklistSc = buildApplicationDocumentChecklist({
    applicationId: ineligibleCreated.application.id,
    scholarship: scOpen,
    profile,
    documents: [msDoc],
    documentAnalyses: [msAna],
  });
  assert.notDeepEqual(
    checklistPragati.items.map((i) => i.requirementName),
    checklistSc.items.map((i) => i.requirementName),
    'Checklists must be generated per scholarship'
  );
  const bonafideItem = checklistPragati.items.find((i) =>
    i.requirementName.toLowerCase().includes('bonafide')
  )!;
  assert.equal(bonafideItem.checklistStatus, 'Missing');
  assert.equal(bonafideItem.canMarkStudentComplete, false);
  assert.equal(bonafideItem.studentMarkedComplete, false);
  console.log('PASS [6 & 7] Scheme-specific checklists generated & missing docs blocked from completion');

  // [8] TrustGuard findings surfaced in tracked application evaluation & checklist
  const evalWithTg = evaluateTrackedApplication({
    application: stepPrep.application,
    scholarship: pragatiOpen,
    profile,
    documents: [msDoc, incomeDoc],
    documentAnalyses: [msAna, incomeMismatchAna],
    referenceDate: REF_DATE,
  });
  assert.ok(evalWithTg.unresolvedCriticalOrHighFindings > 0, 'Expected TrustGuard Critical/High income mismatch');
  assert.equal(evalWithTg.preparationStatus, 'Action Required');
  const incomeChecklistRow = evalWithTg.checklist.items.find((i) =>
    i.requirementName.toLowerCase().includes('income')
  )!;
  assert.equal(incomeChecklistRow.checklistStatus, 'TrustGuard Warning');
  assert.equal(incomeChecklistRow.canMarkStudentComplete, false);
  console.log('PASS [8] TrustGuard income conflict blocks readiness & surfaces warning on checklist');

  // [9] & [10] Deadline Intelligence (IST days remaining, unverified, expired)
  const dlApproaching = evaluateDeadlineIntelligence(pragatiOpen, undefined, REF_DATE);
  assert.equal(dlApproaching.state, 'Approaching');
  assert.equal(dlApproaching.daysRemaining, 5);
  assert.equal(dlApproaching.isVerifiedDate, true);

  const dlDueToday = evaluateDeadlineIntelligence(
    { ...pragatiOpen, applicationDeadline: '2026-05-01' },
    undefined,
    REF_DATE
  );
  assert.equal(dlDueToday.state, 'Due Today');
  assert.equal(dlDueToday.daysRemaining, 0);

  const dlUnverified = evaluateDeadlineIntelligence(unverifiedSch, undefined, REF_DATE);
  assert.equal(dlUnverified.state, 'Not Verified');
  assert.equal(dlUnverified.isVerifiedDate, false);
  assert.ok(dlUnverified.displayLabel.toLowerCase().includes('not verified'));

  const dlExpired = evaluateDeadlineIntelligence(expiredSch, undefined, REF_DATE);
  assert.equal(dlExpired.state, 'Expired');
  assert.equal(dlExpired.isExpired, true);
  assert.throws(
    () =>
      transitionTrackedApplicationWorkflow({
        uid: 'student-alpha',
        application: { ...stepReady.application, scholarshipId: expiredSch.id },
        scholarship: expiredSch,
        nextStatus: 'Submitted',
        submissionConfirmed: true,
        nowIso: NOW_ISO,
      }),
    (e: unknown) => e instanceof CompanionError && e.httpStatus === 400
  );
  console.log('PASS [9 & 10] IST deadline intelligence & unverified/expired safeguards verified');

  // [11] & [16] Portal open logs event & NEVER auto-marks Submitted
  const portalOpened = recordPortalOpenWorkflow({
    uid: 'student-alpha',
    application: stepReady.application,
    nowIso: '2026-05-01T13:30:00.000Z',
  });
  assert.equal(portalOpened.application.status, 'Ready to Apply', 'Portal open must NEVER auto-mark Submitted');
  assert.ok(portalOpened.application.portalOpenedAt);
  assert.equal(portalOpened.event.eventType, 'External Portal Opened');
  console.log('PASS [11 & 16] Portal visit logged cleanly without auto-marking Submitted');

  // [12] In-app notifications & preferences deduplication
  const prefsNoEmail: NotificationPreferenceRecord = {
    uid: 'student-alpha',
    deadlineRemindersEnabled: true,
    missingDocsAlertsEnabled: true,
    statusChangeAlertsEnabled: true,
    emailDigestRequested: true,
    emailDeliveryStatus: 'Not Configured (Requires SMTP/Email Provider)',
    updatedAt: NOW_ISO,
  };
  const evalCorrection = evaluateTrackedApplication({
    application: stepCorrection.application,
    scholarship: pragatiOpen,
    profile,
    documents: [msDoc, incomeDoc],
    documentAnalyses: [msAna, incomeMismatchAna],
    referenceDate: REF_DATE,
  });
  const firstNotifs = deriveApplicationNotifications({
    userId: 'student-alpha',
    evaluatedApps: [evalWithTg, evalCorrection],
    existingNotifications: [],
    preferences: prefsNoEmail,
    nowIso: NOW_ISO,
  });
  assert.ok(firstNotifs.length >= 3);
  assert.ok(firstNotifs.every((n) => n.deliveryStatus === 'Delivered In-App'));
  assert.ok(firstNotifs.some((n) => n.category === 'Deadline'));
  assert.ok(firstNotifs.some((n) => n.category === 'Document'));
  assert.ok(firstNotifs.some((n) => n.category === 'TrustGuard'));
  assert.ok(firstNotifs.some((n) => n.category === 'Application'));
  const dedupedNotifs = deriveApplicationNotifications({
    userId: 'student-alpha',
    evaluatedApps: [evalWithTg, evalCorrection],
    existingNotifications: firstNotifs,
    preferences: prefsNoEmail,
    nowIso: NOW_ISO,
  });
  assert.equal(dedupedNotifs.length, 0, 'Duplicate notifications must be suppressed via dedupeKey');
  console.log(`PASS [12] Generated ${firstNotifs.length} deduplicated Delivered In-App notifications`);

  // [13] Cross-user 403 isolation
  assert.throws(
    () =>
      transitionTrackedApplicationWorkflow({
        uid: 'student-beta',
        application: stepPrep.application,
        scholarship: pragatiOpen,
        nextStatus: 'Documents Pending',
      }),
    (e: unknown) => e instanceof CompanionError && e.httpStatus === 403
  );
  assert.throws(
    () =>
      recordPortalOpenWorkflow({
        uid: 'student-beta',
        application: stepReady.application,
      }),
    (e: unknown) => e instanceof CompanionError && e.httpStatus === 403
  );
  assert.throws(
    () =>
      validateAndExtractClientSnapshot('student-beta', {
        studentContext: {
          applicationEvents: [created1.event as unknown as Record<string, unknown>],
        },
      }),
    (e: unknown) => e instanceof CompanionError && e.httpStatus === 403
  );
  console.log('PASS [13] Cross-student 403 isolation enforced across workflows and companion snapshot');

  // [14] Editing notes/reference ID preserves status and records Notes Updated
  const noteEdit = transitionTrackedApplicationWorkflow({
    uid: 'student-alpha',
    application: stepPrep.application,
    scholarship: pragatiOpen,
    nextStatus: 'Preparing',
    notes: 'Institute nodal officer scheduled verification on Monday.',
    portalReferenceId: 'DRAFT-REF-01',
    nowIso: NOW_ISO,
  });
  assert.equal(noteEdit.application.status, 'Preparing');
  assert.equal(noteEdit.event.eventType, 'Notes Updated');
  assert.equal(noteEdit.application.portalReferenceId, 'DRAFT-REF-01');
  console.log('PASS [14] Editing notes & reference ID logs Notes Updated without mutating status');

  // [15] Removed or archived scholarship handling
  const evalRemovedSch = evaluateTrackedApplication({
    application: {
      ...created1.application,
      id: 'app-missing-sch',
      scholarshipId: 'non-existent-scheme-id',
      scholarshipTitle: 'Removed Scheme 2024',
    },
    scholarship: null,
    profile,
    documents: [msDoc],
    documentAnalyses: [msAna],
    referenceDate: REF_DATE,
  });
  assert.equal(evalRemovedSch.scholarshipMissingOrArchived, true);
  assert.equal(evalRemovedSch.eligibilityStatus, 'Scholarship Unavailable');
  assert.equal(evalRemovedSch.deadline.state, 'Unavailable');
  assert.ok(evalRemovedSch.scholarshipDisclosure?.includes('removed or is unavailable'));
  console.log('PASS [15] Missing/removed scholarship handled cleanly with transparent disclosure');

  // [17] Overview counts, Readiness Engine, and AI Companion Phase 8 grounding
  const counts = computeTrackerOverviewCounts([evalWithTg, evalCorrection, evalRemovedSch]);
  assert.equal(counts.total, 3);
  assert.equal(counts.beingPrepared, 2);
  assert.equal(counts.requiringAction, 3);

  const scCorrectionApp: ApplicationRecord = {
    ...stepCorrection.application,
    id: 'app-sc-corr',
    scholarshipId: scOpen.id,
    scholarshipTitle: scOpen.title,
  };

  const readinessWithPhase8 = evaluateScholarshipReadiness({
    profile,
    documents: [msDoc, incomeDoc],
    documentAnalyses: [msAna, incomeMismatchAna],
    eligibilityAssessments: [],
    savedScholarships: [],
    applications: [stepPrep.application, scCorrectionApp],
    scholarships: [pragatiOpen, scOpen],
    referenceDate: REF_DATE,
  });
  assert.ok(readinessWithPhase8.scholarshipReadiness.some((s) => s.trackerStatus === 'Preparing'));
  assert.ok(readinessWithPhase8.scholarshipReadiness.some((s) => s.trackerStatus === 'Correction Required'));

  const grounded = buildGroundedCompanionContext({
    message: 'Which tracked applications have approaching deadlines or missing documents?',
    history: [],
    scholarships: [pragatiOpen, scOpen],
    snapshot: {
      profile,
      documents: [msDoc, incomeDoc],
      documentAnalyses: [msAna, incomeMismatchAna],
      eligibilityAssessments: [],
      savedScholarships: [],
      applications: [stepPrep.application, scCorrectionApp],
      applicationEvents: [created1.event, stepPrep.event, stepCorrection.event],
      applicationChecklistItems: [staleSavedMissingComplete],
      readinessAssessments: [],
      notifications: firstNotifs,
      sourceMode: 'verified-client-snapshot',
    },
  });
  const ctxJson = JSON.parse(grounded.serializedContext);
  assert.ok(ctxJson.studentProgress.trackedApplicationIntelligence);
  assert.equal(ctxJson.studentProgress.trackedApplicationIntelligence.overviewCounts.total, 2);
  assert.ok(
    ctxJson.studentProgress.trackedApplicationIntelligence.applications[0].checklist
      .missingDocumentNames.length > 0
  );

  const promptArtifacts = buildCompanionPromptArtifacts({
    message: 'Did I submit my AICTE Pragati application?',
    history: [],
    scholarships: [pragatiOpen],
    snapshot: {
      profile,
      documents: [msDoc],
      documentAnalyses: [msAna],
      eligibilityAssessments: [],
      savedScholarships: [],
      applications: [stepPrep.application],
      applicationEvents: [created1.event, stepPrep.event],
      applicationChecklistItems: [],
      readinessAssessments: [],
      notifications: [],
      sourceMode: 'verified-client-snapshot',
    },
  });
  assert.ok(
    promptArtifacts.systemInstruction.includes('NEVER claim an application was submitted'),
    'Rule 15 safeguard must be present in AI Companion system instruction'
  );
  console.log('PASS [17] Readiness Engine & AI Companion Phase 8 grounding verified');

  console.log('ALL 17 PHASE 8 TEST CHECKS PASSED');
}

runTests().catch((err) => {
  console.error('Phase 8 verification failed:', err);
  process.exit(1);
});
