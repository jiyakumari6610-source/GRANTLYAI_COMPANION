import 'dotenv/config';
import assert from 'node:assert/strict';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../src/data/verifiedScholarships.ts';
import { calculateMarksheetAggregates } from '../src/lib/marksheetCalculator.ts';
import {
  computeReadinessDataFingerprint,
  evaluateScholarshipReadiness,
  READINESS_ALGORITHM_VERSION,
  READINESS_SCORING_CONFIG,
} from '../src/lib/readinessEngine.ts';
import {
  buildGroundedCompanionContext,
  CompanionError,
  validateAndExtractClientSnapshot,
} from '../src/server/companionContext.ts';
import type {
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  SavedScholarship,
  StudentProfile,
} from '../src/types/database.ts';

const NOW = '2026-05-01T10:00:00.000Z';

function makeCompleteProfile(uid = 'student-alpha'): StudentProfile {
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
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeVerifiedCbseClass10Marksheet(uid = 'student-alpha') {
  const cbseSummary = calculateMarksheetAggregates({
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
      {
        subjectCode: '184',
        subjectName: 'English Language & Literature',
        subjectCategory: 'main',
        theoryMarks: 76,
        internalOrPracticalMarks: 20,
        printedTotalMarks: 96,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
      {
        subjectCode: '002',
        subjectName: 'Hindi Course-A',
        subjectCategory: 'main',
        theoryMarks: 79,
        internalOrPracticalMarks: 20,
        printedTotalMarks: 99,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
      {
        subjectCode: '041',
        subjectName: 'Mathematics Standard',
        subjectCategory: 'main',
        theoryMarks: 70,
        internalOrPracticalMarks: 20,
        printedTotalMarks: 90,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
      {
        subjectCode: '086',
        subjectName: 'Science',
        subjectCategory: 'main',
        theoryMarks: 75,
        internalOrPracticalMarks: 20,
        printedTotalMarks: 95,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
      {
        subjectCode: '087',
        subjectName: 'Social Science',
        subjectCategory: 'main',
        theoryMarks: 77,
        internalOrPracticalMarks: 20,
        printedTotalMarks: 97,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
      {
        subjectCode: '402',
        subjectName: 'Information Technology',
        subjectCategory: 'additional',
        theoryMarks: 45,
        internalOrPracticalMarks: 50,
        printedTotalMarks: 95,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
    ],
  });

  const doc: DocumentRecord = {
    id: 'doc-marksheet-10',
    userId: uid,
    documentType: 'Academic Marksheet',
    fileName: 'cbse_class10_marksheet.pdf',
    storagePath: 'private-vault/doc-marksheet-10',
    verificationStatus: 'Analyzed',
    processingStatus: 'Completed',
    createdAt: NOW,
    updatedAt: NOW,
  };

  const analysis: DocumentAnalysis = {
    id: 'ana-marksheet-10',
    userId: uid,
    documentId: 'doc-marksheet-10',
    detectedType: 'Academic Marksheet',
    readabilityStatus: 'Readable',
    overallConfidence: 'High',
    extractedFields: [{ fieldName: 'Candidate Name', value: 'Ananya Sharma', confidence: 'High', status: 'Extracted' }],
    marksheetSummary: cbseSummary,
    readinessVerdict: 'Ready',
    createdAt: NOW,
  };

  return { doc, analysis, cbseSummary };
}

function makeReadySupportDocs(uid = 'student-alpha'): {
  docs: DocumentRecord[];
  analyses: DocumentAnalysis[];
} {
  const specs = [
    { id: 'doc-aadhaar', type: 'Aadhaar / Identity Document', detected: 'Aadhaar Card', file: 'aadhaar.pdf' },
    { id: 'doc-income', type: 'Income Certificate', detected: 'Income Certificate', file: 'income.pdf' },
    { id: 'doc-bonafide', type: 'Bonafide Certificate', detected: 'Bonafide Certificate', file: 'bonafide.pdf' },
    { id: 'doc-bank', type: 'Bank Passbook', detected: 'Bank Passbook', file: 'bank_passbook.pdf' },
    { id: 'doc-domicile', type: 'Domicile Certificate', detected: 'Domicile Certificate', file: 'domicile.pdf' },
  ];

  const docs: DocumentRecord[] = specs.map((s) => ({
    id: s.id,
    userId: uid,
    documentType: s.type,
    fileName: s.file,
    storagePath: `private-vault/${s.id}`,
    verificationStatus: 'Verified',
    processingStatus: 'Completed',
    createdAt: NOW,
    updatedAt: NOW,
  }));

  const analyses: DocumentAnalysis[] = specs.map((s) => ({
    id: `ana-${s.id}`,
    userId: uid,
    documentId: s.id,
    detectedType: s.detected,
    readabilityStatus: 'Readable',
    overallConfidence: 'High',
    extractedFields: [{ fieldName: 'Applicant Name', value: 'Ananya Sharma', confidence: 'High', status: 'Extracted' }],
    readinessVerdict: 'Ready',
    createdAt: NOW,
  }));

  return { docs, analyses };
}

async function runTests() {
  console.log('--- Phase 6 Scholarship Readiness Intelligence Verification ---');

  assert.equal(
    READINESS_SCORING_CONFIG.weights.profile +
      READINESS_SCORING_CONFIG.weights.academic +
      READINESS_SCORING_CONFIG.weights.documents +
      READINESS_SCORING_CONFIG.weights.eligibility +
      READINESS_SCORING_CONFIG.weights.application,
    100,
    'Dimension weights must total 100'
  );

  // Use a realistic active verified scholarship subset for deterministic cycle checks too
  const pragatiWithOpenWindow = VERIFIED_INDIAN_SCHOLARSHIPS.map((s) =>
    s.id === 'aicte-pragati-girls-technical'
      ? {
          ...s,
          applicationStatus: 'Currently accepting applications' as const,
          applicationDeadline: '2026-12-31',
        }
      : s
  );

  const profile = makeCompleteProfile('student-alpha');
  const { doc: msDoc, analysis: msAna } = makeVerifiedCbseClass10Marksheet('student-alpha');
  const support = makeReadySupportDocs('student-alpha');

  const savedPragati: SavedScholarship = {
    id: 'student-alpha_aicte-pragati-girls-technical',
    userId: 'student-alpha',
    scholarshipId: 'aicte-pragati-girls-technical',
    createdAt: NOW,
  };
  const appPragati: ApplicationRecord = {
    id: 'app-pragati',
    userId: 'student-alpha',
    scholarshipId: 'aicte-pragati-girls-technical',
    scholarshipTitle: 'AICTE Pragati Scholarship Scheme for Girl Students',
    status: 'Submitted',
    portalReferenceId: 'AICTE-2026-8842',
    createdAt: NOW,
    updatedAt: NOW,
  };

  // Scenario 1: Complete profile, verified marksheet, ready documents, tracked/submitted application
  {
    const report = evaluateScholarshipReadiness({
      profile,
      documents: [msDoc, ...support.docs],
      documentAnalyses: [msAna, ...support.analyses],
      eligibilityAssessments: [],
      savedScholarships: [savedPragati],
      applications: [appPragati],
      scholarships: pragatiWithOpenWindow,
    });
    assert.equal(report.algorithmVersion, READINESS_ALGORITHM_VERSION);
    assert.equal(report.assessmentStatus, 'Ready');
    assert.ok(
      report.overallScore !== null && report.overallScore >= READINESS_SCORING_CONFIG.thresholds.ready,
      `Expected >=${READINESS_SCORING_CONFIG.thresholds.ready}, got ${report.overallScore}`
    );
    assert.equal(report.profileCompletenessPercent, 100);
    assert.equal(report.documentCoveragePercent, 100);
    assert.equal(report.missingDocuments.length, 0);
    assert.equal(report.flaggedDocuments.length, 0);
    console.log(`PASS [1] Complete profile & verified docs -> ${report.overallScore}/100 (${report.assessmentStatus})`);
  }

  // Scenario 2: Missing profile information -> lower score, missing fields listed, or Assessment Incomplete if minimal
  {
    const sparseProfile: StudentProfile = {
      uid: 'student-sparse',
      fullName: 'Rohan Verma',
      email: 'rohan@example.com',
      onboardingCompleted: false,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const incompleteReport = evaluateScholarshipReadiness({
      profile: sparseProfile,
      documents: [],
      documentAnalyses: [],
      eligibilityAssessments: [],
      savedScholarships: [],
      applications: [],
      scholarships: pragatiWithOpenWindow,
    });
    assert.equal(incompleteReport.assessmentStatus, 'Assessment Incomplete');
    assert.equal(incompleteReport.overallScore, null, 'Minimal missing profile must show Assessment Incomplete instead of numeric score');

    const partialProfile: StudentProfile = {
      ...profile,
      familyAnnualIncomeInr: null,
      category: undefined,
      state: undefined,
    };
    const partialReport = evaluateScholarshipReadiness({
      profile: partialProfile,
      documents: [msDoc],
      documentAnalyses: [msAna],
      eligibilityAssessments: [],
      savedScholarships: [],
      applications: [],
      scholarships: pragatiWithOpenWindow,
    });
    assert.ok(partialReport.overallScore !== null && partialReport.overallScore < 75);
    assert.ok(partialReport.missingProfileFields.includes('Domicile state'));
    assert.ok(partialReport.missingProfileFields.includes('Family annual income (INR)'));
    console.log(`PASS [2] Missing profile info handled (${incompleteReport.assessmentStatus} & reduced score ${partialReport.overallScore})`);
  }

  // Scenario 3: No uploaded documents -> Document & Academic marksheet deductions
  {
    const report = evaluateScholarshipReadiness({
      profile,
      documents: [],
      documentAnalyses: [],
      eligibilityAssessments: [],
      savedScholarships: [savedPragati],
      applications: [],
      scholarships: pragatiWithOpenWindow,
    });
    const docDim = report.dimensionScores.find((d) => d.key === 'documents')!;
    const acadDim = report.dimensionScores.find((d) => d.key === 'academic')!;
    assert.equal(docDim.earnedPoints, 0);
    assert.equal(acadDim.earnedPoints, 12, 'Should award course(3)+year(3)+profileMarks(6)=12, 0 for marksheet verification');
    assert.ok(report.missingDocuments.length > 0);
    console.log(`PASS [3] Zero documents awards 0 doc points (${report.overallScore}/100)`);
  }

  // Scenario 4: Partially processed / Needs Review / Failed documents -> never full points just for uploading
  {
    const needsReviewIncome: DocumentRecord = {
      id: 'doc-inc-flagged',
      userId: 'student-alpha',
      documentType: 'Income Certificate',
      fileName: 'blurry_income.jpg',
      storagePath: 'private-vault/doc-inc-flagged',
      verificationStatus: 'Needs Attention',
      processingStatus: 'Needs Review',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const needsReviewAna: DocumentAnalysis = {
      id: 'ana-inc-flagged',
      userId: 'student-alpha',
      documentId: 'doc-inc-flagged',
      detectedType: 'Income Certificate',
      readabilityStatus: 'Partially Readable',
      issuesFound: ['Issuing officer seal blurred'],
      readinessVerdict: 'Needs Clarification',
      createdAt: NOW,
    };
    const failedAadhaar: DocumentRecord = {
      id: 'doc-aadhaar-fail',
      userId: 'student-alpha',
      documentType: 'Aadhaar / Identity Document',
      fileName: 'corrupted_aadhaar.pdf',
      storagePath: 'private-vault/doc-aadhaar-fail',
      verificationStatus: 'Needs Attention',
      processingStatus: 'Failed',
      createdAt: NOW,
      updatedAt: NOW,
    };

    const report = evaluateScholarshipReadiness({
      profile,
      documents: [msDoc, needsReviewIncome, failedAadhaar],
      documentAnalyses: [msAna, needsReviewAna],
      eligibilityAssessments: [],
      savedScholarships: [savedPragati],
      applications: [],
      scholarships: pragatiWithOpenWindow,
    });
    assert.notEqual(report.assessmentStatus, 'Ready', 'Flagged documents must prevent Ready status');
    assert.ok(report.flaggedDocuments.some((d) => d.includes('Income Certificate')));
    assert.ok(report.missingDocuments.some((d) => d.includes('Aadhaar')), 'Failed document must be treated as missing/unusable');
    assert.ok(report.documentCoveragePercent < 50);
    console.log(`PASS [4] Needs Review gives partial credit & Failed gives 0 credit (${report.documentCoveragePercent}% doc coverage)`);
  }

  // Scenario 5: CBSE Class 10 marksheet extracted & calculated (477/500 = 95.4%)
  {
    const profileNoMarks: StudentProfile = { ...profile, previousMarksPercent: null };
    const report = evaluateScholarshipReadiness({
      profile: profileNoMarks,
      documents: [msDoc],
      documentAnalyses: [msAna],
      eligibilityAssessments: [],
      savedScholarships: [],
      applications: [],
      scholarships: pragatiWithOpenWindow,
    });
    const acadDim = report.dimensionScores.find((d) => d.key === 'academic')!;
    assert.equal(acadDim.earnedPoints, 20, 'Verified CBSE 477/500 (95.4%) marksheet should yield full 20/20 academic points');
    assert.ok(acadDim.summary.includes('95.4%'));
    console.log('PASS [5] Verified CBSE Class 10 marksheet (477/500 = 95.4%) gives full Academic Readiness');
  }

  // Scenario 6: Failed eligibility criterion -> never treated as application-ready
  {
    const report = evaluateScholarshipReadiness({
      profile, // OBC-NCL female with 3.2L income
      documents: [msDoc, ...support.docs],
      documentAnalyses: [msAna, ...support.analyses],
      eligibilityAssessments: [],
      savedScholarships: [],
      applications: [],
      scholarships: pragatiWithOpenWindow,
    });
    const scPostMatric = report.scholarshipReadiness.find((s) => s.scholarshipId === 'nsp-post-matric-sc')!;
    assert.equal(scPostMatric.eligibilityStatus, 'Not Eligible');
    assert.equal(scPostMatric.readinessPercent, 0);
    assert.equal(scPostMatric.readinessLabel, 'Not Eligible');
    assert.ok(scPostMatric.failedCriteria.length > 0);
    console.log('PASS [6] Ineligible scholarship (SC scheme for OBC student) clamped to 0% / Not Eligible');
  }

  // Scenario 7: Unknown eligibility information -> never rewarded as passed
  {
    const profileMissingIncome: StudentProfile = {
      ...profile,
      familyAnnualIncomeInr: null,
    };
    const potentialReport = evaluateScholarshipReadiness({
      profile: profileMissingIncome,
      documents: [msDoc, ...support.docs],
      documentAnalyses: [msAna, ...support.analyses],
      eligibilityAssessments: [],
      savedScholarships: [savedPragati],
      applications: [],
      scholarships: pragatiWithOpenWindow,
    });
    const pragatiPotential = potentialReport.scholarshipReadiness.find(
      (s) => s.scholarshipId === 'aicte-pragati-girls-technical'
    )!;
    assert.equal(pragatiPotential.eligibilityStatus, 'Potentially Eligible');
    assert.ok(pragatiPotential.unknownCriteria.includes('Annual Family Income'));
    assert.ok(pragatiPotential.readinessPercent !== null && pragatiPotential.readinessPercent <= 82);

    const profileMajorityUnknown: StudentProfile = {
      ...profile,
      familyAnnualIncomeInr: null,
      courseSpecialization: undefined,
      educationLevel: undefined,
      gender: undefined,
    };
    const insufficientReport = evaluateScholarshipReadiness({
      profile: profileMajorityUnknown,
      documents: [msDoc],
      documentAnalyses: [msAna],
      eligibilityAssessments: [],
      savedScholarships: [savedPragati],
      applications: [],
      scholarships: pragatiWithOpenWindow,
    });
    const pragatiInsufficient = insufficientReport.scholarshipReadiness.find(
      (s) => s.scholarshipId === 'aicte-pragati-girls-technical'
    )!;
    assert.equal(pragatiInsufficient.eligibilityStatus, 'Insufficient Information');
    assert.equal(pragatiInsufficient.readinessPercent, null);
    assert.equal(pragatiInsufficient.readinessLabel, 'Blocked — Missing Info');
    const eligDim = insufficientReport.dimensionScores.find((d) => d.key === 'eligibility')!;
    assert.ok(eligDim.earnedPoints < 20, 'Unknown criteria must reduce Eligibility Readiness points');
    console.log(
      `PASS [7] Unknown criteria never rewarded (Potentially Eligible <=82% & Insufficient Information blocked; ${eligDim.earnedPoints}/20 eligibility pts)`
    );
  }

  // Scenario 8: Multiple relevant scholarships -> distinct per-scholarship readiness scores & checklists
  {
    const report = evaluateScholarshipReadiness({
      profile,
      documents: [msDoc], // only marksheet ready
      documentAnalyses: [msAna],
      eligibilityAssessments: [],
      savedScholarships: [],
      applications: [],
      scholarships: pragatiWithOpenWindow,
    });
    assert.equal(report.scholarshipReadiness.length, pragatiWithOpenWindow.length);
    const pragati = report.scholarshipReadiness.find((s) => s.scholarshipId === 'aicte-pragati-girls-technical')!;
    const csss = report.scholarshipReadiness.find((s) => s.scholarshipId === 'nsp-central-sector-college-university')!;
    assert.equal(pragati.eligibilityStatus, 'Eligible');
    assert.equal(csss.eligibilityStatus, 'Eligible');
    assert.ok(pragati.missingDocuments.length >= 2);
    assert.ok(report.recommendedActions.length >= 3);
    // Actions should be sorted by priority & unblocksCount descending
    assert.ok(report.recommendedActions[0].unblocksCount >= report.recommendedActions[report.recommendedActions.length - 1].unblocksCount ||
      report.recommendedActions[0].priority === 'High');
    console.log(`PASS [8] Multiple scholarships evaluated (${report.scholarshipReadiness.length} schemes, ${report.recommendedActions.length} prioritized actions)`);
  }

  // Scenario 9: Empty scholarship database -> explicit No Scholarship Data state & zero fake recommendations
  {
    const emptyDbReport = evaluateScholarshipReadiness({
      profile,
      documents: [msDoc],
      documentAnalyses: [msAna],
      eligibilityAssessments: [],
      savedScholarships: [],
      applications: [],
      scholarships: [],
    });
    assert.equal(emptyDbReport.assessmentStatus, 'No Scholarship Data');
    assert.equal(emptyDbReport.overallScore, null);
    assert.equal(emptyDbReport.scholarshipsAvailableCount, 0);
    assert.equal(emptyDbReport.scholarshipReadiness.length, 0);
    assert.ok(emptyDbReport.dataAvailabilityWarning?.includes('empty'));
    console.log('PASS [9] Empty scholarship database returns No Scholarship Data & overallScore: null');
  }

  // Scenario 10: Profile or document update changes dataFingerprint & recalculates score
  {
    const baseReport = evaluateScholarshipReadiness({
      profile,
      documents: [msDoc],
      documentAnalyses: [msAna],
      eligibilityAssessments: [],
      savedScholarships: [savedPragati],
      applications: [],
      scholarships: pragatiWithOpenWindow,
    });
    const updatedReport = evaluateScholarshipReadiness({
      profile,
      documents: [msDoc, ...support.docs],
      documentAnalyses: [msAna, ...support.analyses],
      eligibilityAssessments: [],
      savedScholarships: [savedPragati],
      applications: [appPragati],
      scholarships: pragatiWithOpenWindow,
    });
    assert.notEqual(baseReport.dataFingerprint, updatedReport.dataFingerprint);
    assert.ok((updatedReport.overallScore ?? 0) > (baseReport.overallScore ?? 0));
    console.log(
      `PASS [10] Stale fingerprint detection verified (${baseReport.dataFingerprint} -> ${updatedReport.dataFingerprint}; score ${baseReport.overallScore} -> ${updatedReport.overallScore})`
    );
  }

  // Scenario 11: Student isolation & AI Companion readiness grounding
  {
    const alphaProfile = makeCompleteProfile('student-alpha');
    const betaProfile = makeCompleteProfile('student-beta');
    assert.notEqual(alphaProfile.uid, betaProfile.uid);

    // Server cross-UID rejection check
    assert.throws(
      () =>
        validateAndExtractClientSnapshot('student-alpha', {
          studentContext: {
            profile: betaProfile as unknown as Record<string, unknown>,
          },
        }),
      (err: unknown) => err instanceof CompanionError && err.httpStatus === 403
    );

    // AI Companion receives exact readinessIntelligence in grounded context
    const grounded = buildGroundedCompanionContext({
      message: 'Why is my readiness score at its current level and what should I complete this week?',
      history: [],
      scholarships: pragatiWithOpenWindow,
      snapshot: {
        profile: alphaProfile,
        documents: [msDoc],
        documentAnalyses: [msAna],
        eligibilityAssessments: [],
        savedScholarships: [savedPragati],
        applications: [],
        readinessAssessments: [],
        notifications: [],
        sourceMode: 'verified-client-snapshot',
      },
    });
    const ctx = JSON.parse(grounded.serializedContext);
    assert.ok(ctx.studentProgress.readinessIntelligence, 'Companion context must include Phase 6 readinessIntelligence');
    assert.equal(ctx.studentProgress.readinessIntelligence.algorithmVersion, READINESS_ALGORITHM_VERSION);
    assert.equal(ctx.studentProgress.readinessIntelligence.dimensionScores.length, 5);
    assert.ok(ctx.studentProgress.readinessIntelligence.topPrioritizedActions.length > 0);
    console.log('PASS [11] Cross-student 403 isolation & AI Companion readiness grounding verified');
  }

  console.log('ALL 11 PHASE 6 SCENARIOS PASSED');
}

runTests().catch((err) => {
  console.error('Phase 6 verification failed:', err);
  process.exit(1);
});
