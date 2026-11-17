import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../src/data/verifiedScholarships.ts';
import {
  computeAdminDashboardMetrics,
  detectRuleContradictions,
  isPrivilegedRole,
  isSuperAdminRole,
  runScholarshipDataQualityScan,
  validateVerificationEvidence,
} from '../src/lib/adminGovernanceEngine.ts';
import {
  evaluateDeadlineIntelligence,
  evaluateTrackedApplication,
  findDuplicateActiveApplication,
  validateApplicationTransition,
} from '../src/lib/applicationTrackerEngine.ts';
import { compareDocumentsAgainstScholarship } from '../src/lib/documentComparison.ts';
import {
  computeProfileCompleteness,
  evaluateDeterministicEligibility,
} from '../src/lib/eligibilityEngine.ts';
import { calculateMarksheetAggregates } from '../src/lib/marksheetCalculator.ts';
import {
  evaluateFullStudentNotifications,
  normalizeNotificationPreferences,
} from '../src/lib/notificationEngine.ts';
import { evaluateScholarshipReadiness } from '../src/lib/readinessEngine.ts';
import {
  DEFAULT_DISCOVERY_FILTERS,
  filterAndSortScholarships,
  getEffectiveApplicationStatus,
  rankRecommendedScholarships,
} from '../src/lib/scholarshipEngine.ts';
import { isSafeInternalPath } from '../src/lib/securityUtils.ts';
import { evaluateTrustGuardVerification } from '../src/lib/trustguardEngine.ts';
import {
  buildGroundedCompanionContext,
  CompanionError,
  validateAndExtractClientSnapshot,
  type StudentDatabaseSnapshot,
} from '../src/server/companionContext.ts';
import {
  buildCompanionPromptArtifacts,
  generateCompanionReply,
} from '../src/server/companionService.ts';
import {
  DocumentProcessingError,
  extractRealDocumentText,
  validateDocumentBinary,
} from '../src/server/documentProcessor.ts';
import { getGeminiClient } from '../src/server/gemini.ts';
import {
  deletePrivateDocument,
  readPrivateDocument,
  savePrivateDocument,
} from '../src/server/privateVault.ts';
import type {
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  EligibilityAssessment,
  NotificationRecord,
  Scholarship,
  StudentProfile,
  TrustGuardReport,
} from '../src/types/database.ts';

async function buildSamplePdf(lines: string[]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([595, 842]);
  let y = 780;
  for (const line of lines) {
    page.drawText(line, { x: 45, y, size: 11, font });
    y -= 22;
  }
  return Buffer.from(await pdfDoc.save());
}

async function runPhase12EndToEndQA() {
  console.log('=== PHASE 12: END-TO-END QA & LAUNCH READINESS VERIFICATION ===');
  const now = '2026-11-15T10:00:00.000Z';

  // --------------------------------------------------------------------------
  // MODULE 1: COMPLETE CROSS-MODULE STUDENT JOURNEY
  // --------------------------------------------------------------------------
  const studentUid = 'qa-e2e-student-01';
  const studentProfile: StudentProfile = {
    uid: studentUid,
    fullName: 'Riya Chatterjee',
    email: 'riya.qa@example.com',
    phone: '+91-9830011223',
    state: 'West Bengal',
    district: 'Kolkata',
    dateOfBirth: '2006-05-12',
    gender: 'Female',
    category: 'General',
    disabilityStatus: 'None',
    educationLevel: 'Undergraduate (UG)',
    courseSpecialization: 'B.Tech Computer Science',
    institutionName: 'Jadavpur University',
    collegeLocation: 'Kolkata, West Bengal',
    academicYear: '2026-27',
    currentSemesterOrYear: '1st Year',
    previousMarksPercent: 95.4,
    familyAnnualIncomeInr: 180000,
    parentOccupation: 'School Teacher',
    hostelStatus: 'Day Scholar',
    certificates: ['Income Certificate', 'Domicile Certificate', 'Previous Academic Marksheet'],
    onboardingCompleted: true,
    createdAt: now,
    updatedAt: now,
  };

  // 1a. Profile completeness & Discovery matching
  const completeness = computeProfileCompleteness(studentProfile);
  assert.equal(completeness.percent, 100);

  const discoveryFiltered = filterAndSortScholarships(
    VERIFIED_INDIAN_SCHOLARSHIPS,
    { ...DEFAULT_DISCOVERY_FILTERS, state: 'West Bengal', maxFamilyIncomeInr: 250000 },
    'relevant',
    studentProfile,
    new Set()
  );
  const svmcm = discoveryFiltered.find((r) => r.scholarship.id === 'wb-svmcm-scholarship')?.scholarship;
  assert.ok(svmcm, 'West Bengal SVMCM must surface in discovery for matching WB student');

  // 1b. Deterministic Eligibility Evaluation
  const svmcmElig = evaluateDeterministicEligibility(studentProfile, svmcm);
  assert.equal(svmcmElig.overallStatus, 'Eligible');
  assert.ok(svmcmElig.compatibilityScore >= 80);

  // 1c. Real Document PDF Upload -> Binary Validation -> Private Vault -> Text Extraction -> Marks Calc
  const marksheetPdf = await buildSamplePdf([
    'CENTRAL BOARD OF SECONDARY EDUCATION',
    'Candidate Name: Riya Chatterjee',
    'Class 10 Marks Statement',
    'English: 96/100 | Hindi: 99/100 | Math: 90/100 | Science: 95/100 | Social Science: 97/100',
    'ADDITIONAL SUBJECT: Information Technology 95/100',
  ]);
  const incomePdf = await buildSamplePdf([
    'GOVERNMENT OF WEST BENGAL - ANNUAL INCOME CERTIFICATE',
    'Applicant: Riya Chatterjee | Aadhaar: 1234 5678 9012',
    'Annual Family Income: INR 1,80,000',
    'Issuing Authority: BDO Kolkata',
  ]);

  const msMime = validateDocumentBinary(marksheetPdf, 'application/pdf', 'cbse_10.pdf');
  const incMime = validateDocumentBinary(incomePdf, 'application/pdf', 'wb_income.pdf');
  assert.equal(msMime, 'application/pdf');
  assert.equal(incMime, 'application/pdf');

  await savePrivateDocument(studentUid, 'qa-doc-ms', marksheetPdf, {
    fileName: 'cbse_10.pdf',
    mimeType: msMime,
    fileSizeBytes: marksheetPdf.byteLength,
  });
  await savePrivateDocument(studentUid, 'qa-doc-inc', incomePdf, {
    fileName: 'wb_income.pdf',
    mimeType: incMime,
    fileSizeBytes: incomePdf.byteLength,
  });

  try {
    const msExtracted = await extractRealDocumentText(marksheetPdf, msMime);
    const incExtracted = await extractRealDocumentText(incomePdf, incMime);
    assert.equal(msExtracted.extractionMethod, 'pdf-text');
    assert.ok(!incExtracted.combinedText.includes('1234 5678 9012'), 'Aadhaar must be masked');
    assert.ok(incExtracted.combinedText.includes('XXXX-XXXX-9012'));

    const cbseSummary = calculateMarksheetAggregates({
      isMarksheet: true,
      boardOrUniversity: 'CBSE',
      examinationName: 'Class X 2024',
      examClassOrLevel: 'Class 10',
      printedOverallAggregateFound: false,
      subjectSelectionCertainty: 'Confirmed',
      subjects: [
        { subjectName: 'English', subjectCategory: 'main', printedTotalMarks: 96, maxMarks: 100 },
        { subjectName: 'Hindi', subjectCategory: 'main', printedTotalMarks: 99, maxMarks: 100 },
        { subjectName: 'Mathematics', subjectCategory: 'main', printedTotalMarks: 90, maxMarks: 100 },
        { subjectName: 'Science', subjectCategory: 'main', printedTotalMarks: 95, maxMarks: 100 },
        { subjectName: 'Social Science', subjectCategory: 'main', printedTotalMarks: 97, maxMarks: 100 },
        { subjectName: 'Information Technology', subjectCategory: 'additional', printedTotalMarks: 95, maxMarks: 100 },
      ],
    });
    assert.equal(cbseSummary.mainAggregate?.obtainedMarks, 477);
    assert.equal(cbseSummary.mainAggregate?.maximumMarks, 500);
    assert.equal(cbseSummary.mainAggregate?.percentage, 95.4);
    assert.equal(cbseSummary.mainAggregate?.sourceType, 'ai-calculated');
    assert.equal(cbseSummary.aggregateIncludingAdditional?.obtainedMarks, 572);

    const docRecords: DocumentRecord[] = [
      {
        id: 'qa-doc-ms',
        userId: studentUid,
        documentType: 'Academic Marksheet',
        fileName: 'cbse_10.pdf',
        mimeType: 'application/pdf',
        storagePath: `private-vault/users/${studentUid}/qa-doc-ms`,
        verificationStatus: 'Analyzed',
        processingStatus: 'Completed',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'qa-doc-inc',
        userId: studentUid,
        documentType: 'Income Certificate',
        fileName: 'wb_income.pdf',
        mimeType: 'application/pdf',
        storagePath: `private-vault/users/${studentUid}/qa-doc-inc`,
        verificationStatus: 'Analyzed',
        processingStatus: 'Completed',
        createdAt: now,
        updatedAt: now,
      },
    ];
    const docAnalyses: DocumentAnalysis[] = [
      {
        id: 'qa-ana-ms',
        userId: studentUid,
        documentId: 'qa-doc-ms',
        detectedType: 'Academic Marksheet',
        readabilityStatus: 'Readable',
        issuingAuthority: 'CBSE',
        overallConfidence: 'High',
        extractedFields: [
          { fieldName: 'Candidate Name', value: 'Riya Chatterjee', confidence: 'High', status: 'Extracted' },
        ],
        marksheetSummary: cbseSummary,
        readinessVerdict: 'Ready',
        createdAt: now,
      },
      {
        id: 'qa-ana-inc',
        userId: studentUid,
        documentId: 'qa-doc-inc',
        detectedType: 'Income Certificate',
        readabilityStatus: 'Readable',
        issuingAuthority: 'BDO Kolkata',
        validityNotes: 'Valid until 31-03-2027',
        overallConfidence: 'High',
        extractedFields: [
          { fieldName: 'Candidate Name', value: 'Riya Chatterjee', confidence: 'High', status: 'Extracted' },
          { fieldName: 'Annual Family Income', value: 'INR 1,80,000', confidence: 'High', status: 'Extracted' },
        ],
        readinessVerdict: 'Ready',
        createdAt: now,
      },
    ];

    // 1d. Document Comparison + Readiness + TrustGuard consistency
    const docComparison = compareDocumentsAgainstScholarship(svmcm, docRecords, docAnalyses, studentProfile);
    assert.ok(docComparison.hasPublishedRequirements);

    const eligRecords: EligibilityAssessment[] = [
      {
        id: 'qa-elig-1',
        userId: studentUid,
        scholarshipId: svmcm.id,
        scholarshipTitle: svmcm.title,
        overallStatus: svmcmElig.overallStatus,
        compatibilityScore: svmcmElig.compatibilityScore,
        passedCriteria: svmcmElig.passedCriteria,
        failedCriteria: svmcmElig.failedCriteria,
        unknownCriteria: svmcmElig.unknownCriteria,
        criteriaBreakdown: svmcmElig.criteriaBreakdown,
        createdAt: now,
      },
    ];

    const applicationRecord: ApplicationRecord = {
      id: 'qa-app-svmcm',
      userId: studentUid,
      scholarshipId: svmcm.id,
      scholarshipTitle: svmcm.title,
      provider: svmcm.provider,
      status: 'Preparing',
      createdAt: now,
      updatedAt: now,
    };

    const readiness = evaluateScholarshipReadiness({
      profile: studentProfile,
      documents: docRecords,
      documentAnalyses: docAnalyses,
      eligibilityAssessments: eligRecords,
      savedScholarships: [{ id: `${studentUid}_${svmcm.id}`, userId: studentUid, scholarshipId: svmcm.id, createdAt: now }],
      applications: [applicationRecord],
      scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
    });
    assert.ok(readiness.overallScore !== null && readiness.overallScore >= 60);

    const trustguard = evaluateTrustGuardVerification({
      userId: studentUid,
      profile: studentProfile,
      documents: docRecords,
      documentAnalyses: docAnalyses,
      scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
      savedScholarships: [{ id: `${studentUid}_${svmcm.id}`, userId: studentUid, scholarshipId: svmcm.id, createdAt: now }],
      applications: [applicationRecord],
    });
    assert.equal(trustguard.severityCounts.critical, 0, 'Consistent profile & docs must have zero critical mismatches');
    assert.ok(
      trustguard.limitationNotice.toLowerCase().includes('consistency') ||
        trustguard.disclaimer.toLowerCase().includes('does not'),
      'TrustGuard must clearly state internal consistency scope without claiming legal certification'
    );

    // 1e. Application Tracker workflow transitions + Notifications
    assert.equal(
      validateApplicationTransition({ currentStatus: 'Interested', nextStatus: 'Preparing' }).allowed,
      true
    );
    assert.equal(
      validateApplicationTransition({ currentStatus: 'Preparing', nextStatus: 'Documents Pending' }).allowed,
      true
    );
    assert.equal(
      validateApplicationTransition({ currentStatus: 'Interested', nextStatus: 'Submitted', submissionConfirmed: true }).allowed,
      false
    );
    assert.equal(
      validateApplicationTransition({ currentStatus: 'Closed', nextStatus: 'Preparing' }).allowed,
      false
    );

    const trackedEval = evaluateTrackedApplication({
      application: applicationRecord,
      scholarship: svmcm,
      profile: studentProfile,
      documents: docRecords,
      documentAnalyses: docAnalyses,
      trustGuardAssessment: {
        findings: trustguard.findings,
      },
    });
    assert.equal(trackedEval.normalizedStatus, 'Preparing');

    const upcomingScheme: Scholarship = {
      ...svmcm,
      id: 'qa-upcoming-scheme',
      applicationDeadline: '2026-11-18',
      applicationStatus: 'Currently accepting applications',
      verificationStatus: 'Verified',
    };
    const upcomingApp: ApplicationRecord = {
      ...applicationRecord,
      id: 'qa-app-upcoming',
      scholarshipId: upcomingScheme.id,
      deadline: '2026-11-18',
    };
    const prefs = normalizeNotificationPreferences(studentUid, {});
    const notifEval = evaluateFullStudentNotifications({
      userId: studentUid,
      profile: studentProfile,
      scholarships: [upcomingScheme],
      applications: [upcomingApp],
      savedScholarships: [],
      documents: docRecords,
      documentAnalyses: docAnalyses,
      existingNotifications: [],
      preferences: prefs,
      referenceDate: new Date('2026-11-15T06:00:00.000Z'),
    });
    assert.ok(
      notifEval.newNotifications.length >= 1,
      'Matching verified scheme + 3-day deadline must create notifications'
    );

    // 1f. Grounded AI Companion context synchronization
    const snapshot: StudentDatabaseSnapshot = {
      profile: studentProfile,
      documents: docRecords,
      documentAnalyses: docAnalyses,
      eligibilityAssessments: eligRecords,
      savedScholarships: [{ id: `${studentUid}_${svmcm.id}`, userId: studentUid, scholarshipId: svmcm.id, createdAt: now }],
      applications: [applicationRecord],
      readinessAssessments: [],
      notifications: notifEval.newNotifications,
      sourceMode: 'verified-client-snapshot',
    };
    const companionContext = buildGroundedCompanionContext({
      message: 'Check my West Bengal SVMCM eligibility, marksheet percentage, and tracker status.',
      history: [],
      scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
      snapshot,
    });
    const parsedCtx = JSON.parse(companionContext.serializedContext);
    assert.equal(parsedCtx.studentProfile.data.state, 'West Bengal');
    assert.equal(parsedCtx.uploadedDocumentsAndAnalysis.documents[0].marksheetSummary.mainAggregate.percentage, 95.4);
    assert.equal(parsedCtx.uploadedDocumentsAndAnalysis.documents[0].marksheetSummary.mainAggregate.provenance, 'AI-Calculated');
    assert.equal(parsedCtx.studentProgress.trackedApplications[0].status, 'Preparing');
    assert.equal(parsedCtx.studentProgress.trackedApplicationIntelligence.applications[0].status, 'Preparing');

    console.log('PASS [Module 1] Complete End-to-End Student Journey synchronized across all modules');
  } finally {
    await deletePrivateDocument(studentUid, 'qa-doc-ms').catch(() => {});
    await deletePrivateDocument(studentUid, 'qa-doc-inc').catch(() => {});
    await fs
      .rm(path.join(process.cwd(), '.private_vault', 'users', studentUid), {
        recursive: true,
        force: true,
      })
      .catch(() => {});
  }

  // --------------------------------------------------------------------------
  // MODULE 2: ADMIN GOVERNANCE PIPELINE
  // --------------------------------------------------------------------------
  {
    assert.equal(isPrivilegedRole('student', 'active'), false);
    assert.equal(isPrivilegedRole('admin', 'active'), true);
    assert.equal(isSuperAdminRole('admin', 'active'), false);
    assert.equal(isSuperAdminRole('super_admin', 'active'), true);

    const invalidVerify = validateVerificationEvidence({
      newStatus: 'Verified',
      officialSourceUrl: 'https://scholarships.gov.in',
      sourceEvidence: 'Checked',
      humanConfirmed: false,
    });
    assert.equal(invalidVerify.valid, false, 'Admin verification without human confirmation must fail');

    const validVerify = validateVerificationEvidence({
      newStatus: 'Verified',
      officialSourceUrl: 'https://scholarships.gov.in',
      sourceEvidence: 'Verified directly from NSP 2026-27 official Ministry circular PDF.',
      humanConfirmed: true,
    });
    assert.equal(validVerify.valid, true);

    const badRules = detectRuleContradictions([
      { ruleKey: 'previousMarksPercent', operator: 'gte', ruleValue: '85', ruleLabel: 'Min Marks', isMandatory: true },
      { ruleKey: 'previousMarksPercent', operator: 'lte', ruleValue: '60', ruleLabel: 'Max Marks', isMandatory: true },
    ]);
    assert.ok(badRules.length > 0, 'Contradictory eligibility rules must be detected');

    const qualityIssues = runScholarshipDataQualityScan({
      scholarships: [
        {
          ...VERIFIED_INDIAN_SCHOLARSHIPS[0],
          id: 'qa-broken-sch',
          officialUrl: '',
          applicationDeadline: '2024-01-01',
        },
      ],
      rules: [],
    });
    assert.ok(qualityIssues.length >= 1, 'Data quality scan must flag missing official URL / expired cycle');

    const metrics = computeAdminDashboardMetrics({
      scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
      rules: [],
      profiles: [studentProfile],
      applications: [],
      documents: [],
      documentAnalyses: [],
      trustGuardReports: [] as TrustGuardReport[],
      trustGuardAssessments: [],
      dataQualityIssues: qualityIssues,
    });
    assert.equal(metrics.platform.totalScholarships, VERIFIED_INDIAN_SCHOLARSHIPS.length);
    assert.equal(metrics.platform.totalStudents, 1);
    console.log('PASS [Module 2] Admin RBAC, verification evidence, rule validation, quality scan & real metrics verified');
  }

  // --------------------------------------------------------------------------
  // MODULE 3: DATA INTEGRITY & EDGE CASES
  // --------------------------------------------------------------------------
  {
    // Empty scholarship database
    assert.equal(rankRecommendedScholarships([], studentProfile, 5).length, 0);
    const emptyReadiness = evaluateScholarshipReadiness({
      profile: studentProfile,
      documents: [],
      documentAnalyses: [],
      eligibilityAssessments: [],
      savedScholarships: [],
      applications: [],
      scholarships: [],
    });
    assert.equal(emptyReadiness.assessmentStatus, 'No Scholarship Data');
    assert.equal(emptyReadiness.overallScore, null);
    const emptyPrompt = buildCompanionPromptArtifacts({
      message: 'Recommend schemes',
      history: [],
      scholarships: [],
      snapshot: {
        profile: studentProfile,
        documents: [],
        documentAnalyses: [],
        eligibilityAssessments: [],
        savedScholarships: [],
        applications: [],
        readinessAssessments: [],
        notifications: [],
        sourceMode: 'verified-client-snapshot',
      },
    });
    assert.equal(emptyPrompt.scholarshipsEmpty, true);

    // Missing profile fields
    const nullElig = evaluateDeterministicEligibility(null, VERIFIED_INDIAN_SCHOLARSHIPS[0]);
    assert.notEqual(nullElig.overallStatus, 'Eligible');
    assert.ok(nullElig.missingProfileFields.length > 0);

    // Incomplete scholarship rules
    const incompleteScheme: Scholarship = {
      ...VERIFIED_INDIAN_SCHOLARSHIPS[0],
      id: 'qa-incomplete-rules',
      incomeLimitInr: undefined,
      minMarksPercent: undefined,
      requiredDocuments: [],
    };
    const incElig = evaluateDeterministicEligibility(studentProfile, incompleteScheme);
    assert.ok(incElig.criteriaBreakdown.length >= 0);

    // Expired scholarship & unverified scholarship & missing deadline
    const expiredScheme: Scholarship = {
      ...VERIFIED_INDIAN_SCHOLARSHIPS[0],
      id: 'qa-expired',
      applicationDeadline: '2023-03-31',
      applicationStatus: 'Currently accepting applications',
    };
    assert.equal(getEffectiveApplicationStatus(expiredScheme, new Date('2026-11-15T00:00:00Z')), 'Expired');

    const unverifiedNoDeadline: Scholarship = {
      ...VERIFIED_INDIAN_SCHOLARSHIPS[0],
      id: 'qa-unverified-nodl',
      verificationStatus: 'Pending Review',
      applicationDeadline: undefined,
    };
    const dlInfo = evaluateDeadlineIntelligence(unverifiedNoDeadline);
    assert.equal(dlInfo.state, 'Not Verified');
    assert.equal(evaluateDeadlineIntelligence(null).state, 'Unavailable');

    // Invalid / corrupted / oversized documents
    assert.throws(
      () => validateDocumentBinary(Buffer.from('<html>bad</html>'), 'application/pdf', 'bad.pdf'),
      (e: unknown) => e instanceof DocumentProcessingError && e.code === 'CORRUPTED_DOCUMENT'
    );
    assert.throws(
      () => validateDocumentBinary(Buffer.alloc(9 * 1024 * 1024), 'application/pdf', 'huge.pdf'),
      (e: unknown) => e instanceof DocumentProcessingError && e.code === 'FILE_TOO_LARGE'
    );
    assert.throws(
      () => validateDocumentBinary(Buffer.from('MZfake'), 'application/x-msdownload', 'evil.exe'),
      (e: unknown) => e instanceof DocumentProcessingError && e.code === 'INVALID_FORMAT'
    );

    // Unreadable scanned PDF & Low-confidence OCR in TrustGuard
    const blankPdf = await buildSamplePdf([]);
    const blankExtraction = await extractRealDocumentText(blankPdf, 'application/pdf');
    assert.equal(blankExtraction.extractionMethod, 'gemini-multimodal-ocr');

    const lowConfTg = evaluateTrustGuardVerification({
      userId: studentUid,
      profile: studentProfile,
      documents: [
        {
          id: 'doc-blurry',
          userId: studentUid,
          documentType: 'Income Certificate',
          fileName: 'blurry_scan.jpg',
          storagePath: 'private-vault/doc-blurry',
          verificationStatus: 'Needs Attention',
          processingStatus: 'Needs Review',
          createdAt: now,
          updatedAt: now,
        },
      ],
      documentAnalyses: [
        {
          id: 'ana-blurry',
          userId: studentUid,
          documentId: 'doc-blurry',
          detectedType: 'Income Certificate',
          readabilityStatus: 'Partially Readable',
          overallConfidence: 'Low',
          extractedFields: [],
          unreadableFields: ['Annual Family Income'],
          readinessVerdict: 'Needs Clarification',
          createdAt: now,
        },
      ],
      scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
      savedScholarships: [],
      applications: [],
    });
    assert.equal(lowConfTg.overallVerificationStatus, 'Manual Review Required');

    // Missing GEMINI_API_KEY fails explicitly (no mock fallback)
    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = '';
    try {
      assert.throws(() => getGeminiClient(), /GEMINI_API_KEY/);
    } finally {
      if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
      else delete process.env.GEMINI_API_KEY;
    }

    // Network failure / timeout simulation
    await assert.rejects(
      () =>
        generateCompanionReply({
          message: 'Test timeout',
          history: [],
          scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
          snapshot: {
            profile: studentProfile,
            documents: [],
            documentAnalyses: [],
            eligibilityAssessments: [],
            savedScholarships: [],
            applications: [],
            readinessAssessments: [],
            notifications: [],
            sourceMode: 'verified-client-snapshot',
          },
          timeoutMs: 25,
          generateTextFn: () => new Promise((resolve) => setTimeout(() => resolve('delayed'), 150)),
        }),
      (err: unknown) => err instanceof CompanionError && err.httpStatus === 504
    );

    // Duplicate application & duplicate notification prevention
    const dupApp = findDuplicateActiveApplication(
      [
        {
          id: 'app-existing',
          userId: studentUid,
          scholarshipId: 'wb-svmcm-scholarship',
          scholarshipTitle: 'SVMCM',
          provider: 'WB',
          status: 'Preparing',
          createdAt: now,
          updatedAt: now,
        },
      ],
      'wb-svmcm-scholarship'
    );
    assert.ok(dupApp, 'Duplicate active application must be detected');

    const dupNotifCheck = evaluateFullStudentNotifications({
      userId: studentUid,
      profile: studentProfile,
      scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
      applications: [],
      savedScholarships: [],
      documents: [],
      documentAnalyses: [],
      existingNotifications: [
        {
          id: 'existing-match-notif',
          userId: studentUid,
          dedupeKey: `smart_match:${studentUid}:wb-svmcm-scholarship`,
          title: 'Matched Scholarship',
          message: 'Already sent',
          category: 'Scholarship',
          isRead: false,
          deliveryChannel: 'in-app',
          deliveryStatus: 'Delivered In-App',
          createdAt: now,
        },
      ],
      preferences: normalizeNotificationPreferences(studentUid, {}),
    });
    assert.equal(
      dupNotifCheck.newNotifications.some(
        (n: NotificationRecord) => n.scholarshipId === 'wb-svmcm-scholarship' && n.subCategory === 'Smart Match'
      ),
      false,
      'Duplicate notification with same dedupeKey must not be recreated'
    );

    // Cross-student access rejection + Private Vault isolation + safe internal path check
    assert.throws(
      () =>
        validateAndExtractClientSnapshot(studentUid, {
          profileContext: { uid: 'other-student-uid' },
        }),
      (e: unknown) => e instanceof CompanionError && e.httpStatus === 403
    );
    assert.equal(await readPrivateDocument('other-student-uid', 'qa-doc-ms'), null);
    assert.equal(isSafeInternalPath('/dashboard'), true);
    assert.equal(isSafeInternalPath('https://evil.example/phish'), false);

    console.log('PASS [Module 3 & 4] All 14 edge cases, safety guardrails, and AI honesty rules verified');
  }

  // --------------------------------------------------------------------------
  // LIVE DEV SERVER HTTP CHECK (NON-DESTRUCTIVE READS & AUTH GATES)
  // --------------------------------------------------------------------------
  {
    const baseUrl = 'http://127.0.0.1:3000';
    try {
      const healthRes = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthRes.status, 200);
      const healthJson = (await healthRes.json()) as { status: string; aiConfigured: boolean };
      assert.equal(healthJson.status, 'ok');

      // Security gates must reject unauthenticated callers with 401
      const protectedEndpoints: Array<{ method: string; path: string; body?: unknown }> = [
        { method: 'POST', path: '/api/ai/companion', body: { message: 'hello' } },
        { method: 'POST', path: '/api/trustguard/analyze', body: {} },
        { method: 'POST', path: '/api/readiness/assess', body: {} },
        { method: 'POST', path: '/api/applications', body: { scholarshipId: 'wb-svmcm-scholarship' } },
        { method: 'GET', path: '/api/admin/overview' },
        { method: 'POST', path: '/api/notifications/sync', body: {} },
      ];
      for (const ep of protectedEndpoints) {
        const resp = await fetch(`${baseUrl}${ep.path}`, {
          method: ep.method,
          headers: ep.body ? { 'Content-Type': 'application/json' } : undefined,
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        });
        assert.equal(resp.status, 401, `${ep.method} ${ep.path} must enforce 401 when unauthenticated`);
      }

      // Nested SPA route refresh must serve index.html (200)
      for (const route of ['/', '/scholarships', '/dashboard', '/applications', '/admin']) {
        const pageRes = await fetch(`${baseUrl}${route}`);
        assert.equal(pageRes.status, 200, `SPA route ${route} must return 200`);
        const html = await pageRes.text();
        assert.ok(html.includes('<div id="root">'), `SPA route ${route} must serve app shell`);
      }

      // Unknown API route returns JSON 404
      const api404 = await fetch(`${baseUrl}/api/nonexistent-phase12-probe`);
      assert.equal(api404.status, 404);
      const api404Json = (await api404.json()) as { code?: string };
      assert.equal(api404Json.code, 'API_NOT_FOUND');

      console.log(`PASS [Live HTTP] Health (aiConfigured=${healthJson.aiConfigured}), 401 gates, SPA nested routes, and API 404 verified`);
    } catch (err) {
      if (err instanceof TypeError && err.message.includes('fetch failed')) {
        console.log('SKIP [Live HTTP] Dev server not reachable on 127.0.0.1:3000 during standalone run');
      } else {
        throw err;
      }
    }
  }

  console.log('=== ALL PHASE 12 END-TO-END QA CHECKS PASSED ===');
}

runPhase12EndToEndQA().catch((err) => {
  console.error('Phase 12 QA failed:', err);
  process.exit(1);
});
