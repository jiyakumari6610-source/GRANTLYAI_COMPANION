import {
  isActiveApplicationStatus,
  normalizeApplicationStatus,
} from './applicationTrackerEngine.ts';
import { compareDocumentsAgainstScholarship } from './documentComparison.ts';
import {
  evaluateDeterministicEligibility,
  isScholarshipSourceVerified,
} from './eligibilityEngine.ts';
import { evaluateTrustGuardVerification } from './trustguardEngine.ts';
import type {
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  EligibilityAssessment,
  ReadinessActionItem,
  ReadinessActionPriority,
  ReadinessActionStatus,
  ReadinessAssessment,
  ReadinessAssessmentStatus,
  ReadinessDimensionScore,
  SavedScholarship,
  Scholarship,
  ScholarshipSpecificReadiness,
  StudentProfile,
} from '../types/database.ts';

export const READINESS_ALGORITHM_VERSION = 'grantly-readiness-v2.0.0';

export const READINESS_DISCLAIMER =
  'Readiness is an internal preparation indicator computed from your stored profile, analyzed documents, and deterministic eligibility rules. It does not guarantee scholarship selection or approval.';

export const READINESS_SCORING_CONFIG = {
  version: READINESS_ALGORITHM_VERSION,
  weights: {
    profile: 20,
    academic: 20,
    documents: 25,
    eligibility: 20,
    application: 15,
  },
  thresholds: {
    ready: 80,
    partiallyReady: 55,
  },
} as const;

export interface ReadinessEvaluationReport {
  algorithmVersion: string;
  assessedAt: string;
  dataFingerprint: string;
  assessmentStatus: ReadinessAssessmentStatus;
  overallScore: number | null;
  readinessPercent: number;
  profileCompletenessPercent: number;
  documentCoveragePercent: number;
  scholarshipsAvailableCount: number;
  dataAvailabilityWarning?: string;
  disclaimer: string;
  dimensionScores: ReadinessDimensionScore[];
  completedRequirements: string[];
  incompleteRequirements: string[];
  deductionReasons: string[];
  missingProfileFields: string[];
  missingDocuments: string[];
  flaggedDocuments: string[];
  scholarshipReadiness: ScholarshipSpecificReadiness[];
  recommendedActions: ReadinessActionItem[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function classifyDimensionStatus(
  scorePercent: number | null
): ReadinessDimensionScore['status'] {
  if (scorePercent === null) return 'Unavailable';
  if (scorePercent >= 80) return 'Strong';
  if (scorePercent >= 50) return 'Moderate';
  if (scorePercent > 0) return 'Needs Attention';
  return 'Incomplete';
}

export function computeReadinessDataFingerprint(params: {
  profile: StudentProfile | null;
  documents: DocumentRecord[];
  documentAnalyses: DocumentAnalysis[];
  eligibilityAssessments: EligibilityAssessment[];
  savedScholarships: SavedScholarship[];
  applications: ApplicationRecord[];
  scholarships: Scholarship[];
}): string {
  const {
    profile,
    documents,
    documentAnalyses,
    eligibilityAssessments,
    savedScholarships,
    applications,
    scholarships,
  } = params;

  const parts = [
    READINESS_ALGORITHM_VERSION,
    `p:${profile?.updatedAt ?? 'none'}:${profile?.onboardingCompleted ? '1' : '0'}:${profile?.previousMarksPercent ?? 'x'}:${profile?.familyAnnualIncomeInr ?? 'x'}:${profile?.state ?? 'x'}:${profile?.category ?? 'x'}:${profile?.educationLevel ?? 'x'}:${profile?.courseSpecialization ?? 'x'}`,
    `d:${documents.length}:${documents.map((d) => `${d.id}:${d.processingStatus ?? d.verificationStatus}:${d.updatedAt}`).sort().join(',')}`,
    `da:${documentAnalyses.length}:${documentAnalyses.map((a) => `${a.id}:${a.readinessVerdict}:${a.marksheetSummary?.confirmationStatus ?? 'none'}:${a.createdAt}`).sort().join(',')}`,
    `ea:${eligibilityAssessments.length}:${eligibilityAssessments.map((e) => `${e.scholarshipId}:${e.overallStatus}:${e.createdAt}`).sort().join(',')}`,
    `sv:${savedScholarships.map((s) => s.scholarshipId).sort().join(',')}`,
    `ap:${applications.map((a) => `${a.scholarshipId}:${a.status}:${a.updatedAt}`).sort().join(',')}`,
    `sc:${scholarships.length}:${scholarships.map((s) => `${s.id}:${s.verificationStatus}:${s.updatedAt}`).sort().join(',')}`,
  ];

  // Compact deterministic FNV-1a hash
  const raw = parts.join('|');
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fp-${(hash >>> 0).toString(16)}`;
}

export function evaluateScholarshipReadiness(params: {
  profile: StudentProfile | null;
  documents: DocumentRecord[];
  documentAnalyses: DocumentAnalysis[];
  eligibilityAssessments: EligibilityAssessment[];
  savedScholarships: SavedScholarship[];
  applications: ApplicationRecord[];
  scholarships: Scholarship[];
  previousActions?: ReadinessActionItem[];
  referenceDate?: Date;
}): ReadinessEvaluationReport {
  const {
    profile,
    documents,
    documentAnalyses,
    eligibilityAssessments,
    savedScholarships,
    applications,
    scholarships,
    previousActions = [],
    referenceDate = new Date(),
  } = params;

  const assessedAt = new Date().toISOString();
  const dataFingerprint = computeReadinessDataFingerprint({
    profile,
    documents,
    documentAnalyses,
    eligibilityAssessments,
    savedScholarships,
    applications,
    scholarships,
  });

  // Latest analysis per document
  const latestAnalysisByDoc = new Map<string, DocumentAnalysis>();
  for (const ana of documentAnalyses) {
    const existing = latestAnalysisByDoc.get(ana.documentId);
    if (!existing || ana.createdAt > existing.createdAt) {
      latestAnalysisByDoc.set(ana.documentId, ana);
    }
  }

  // =========================================================================
  // Dimension A: Profile Completeness (20 pts — identity, socio-economic, enrollment)
  // Does NOT include marks/course/certificates to avoid double counting.
  // =========================================================================
  const profileChecks: Array<{ label: string; ok: boolean }> = [
    { label: 'Full name', ok: Boolean(profile?.fullName?.trim()) },
    { label: 'Phone number', ok: Boolean(profile?.phone?.trim()) },
    { label: 'Domicile state', ok: Boolean(profile?.state?.trim()) },
    { label: 'District', ok: Boolean(profile?.district?.trim()) },
    { label: 'Date of birth', ok: Boolean(profile?.dateOfBirth?.trim()) },
    { label: 'Gender', ok: Boolean(profile?.gender) },
    { label: 'Social category', ok: Boolean(profile?.category) },
    { label: 'Disability status', ok: Boolean(profile?.disabilityStatus) },
    { label: 'Education level', ok: Boolean(profile?.educationLevel) },
    { label: 'Institution name & location', ok: Boolean(profile?.institutionName?.trim() && profile?.collegeLocation?.trim()) },
    { label: 'Family annual income (INR)', ok: typeof profile?.familyAnnualIncomeInr === 'number' },
    { label: 'Parent occupation & hostel status', ok: Boolean(profile?.parentOccupation?.trim() && profile?.hostelStatus) },
  ];

  const profileCompleted = profileChecks.filter((c) => c.ok).map((c) => c.label);
  const profileIncomplete = profileChecks.filter((c) => !c.ok).map((c) => c.label);
  const profileCompletenessPercent = Math.round(
    (profileCompleted.length / profileChecks.length) * 100
  );
  const profileEarnedPoints = round2(
    (profileCompleted.length / profileChecks.length) * READINESS_SCORING_CONFIG.weights.profile
  );
  const profileDeductions = profileIncomplete.map(
    (field) => `Missing profile field: ${field}`
  );

  const profileDimension: ReadinessDimensionScore = {
    key: 'profile',
    label: 'Profile Completeness',
    weightPercent: READINESS_SCORING_CONFIG.weights.profile,
    maxPoints: READINESS_SCORING_CONFIG.weights.profile,
    earnedPoints: profileEarnedPoints,
    scorePercent: profileCompletenessPercent,
    status: classifyDimensionStatus(profileCompletenessPercent),
    summary: `${profileCompleted.length} of ${profileChecks.length} core personal, socio-economic, and enrollment fields completed.`,
    completedRequirements: profileCompleted.map((f) => `Profile: ${f}`),
    incompleteRequirements: profileIncomplete.map((f) => `Complete profile field: ${f}`),
    deductionReasons: profileDeductions,
  };

  // =========================================================================
  // Dimension B: Academic Readiness (20 pts — marks, marksheet extraction, course/year)
  // =========================================================================
  const academicCompleted: string[] = [];
  const academicIncomplete: string[] = [];
  const academicDeductions: string[] = [];
  let academicPoints = 0;

  // B1. Course specialization (3 pts) + Academic year/semester (3 pts)
  if (profile?.courseSpecialization?.trim()) {
    academicPoints += 3;
    academicCompleted.push(`Course specialization recorded (${profile.courseSpecialization.trim()})`);
  } else {
    academicIncomplete.push('Add course / specialization to profile');
    academicDeductions.push('Course or specialization is missing (-3 pts).');
  }

  if (profile?.academicYear?.trim() && profile?.currentSemesterOrYear?.trim()) {
    academicPoints += 3;
    academicCompleted.push(
      `Academic year & semester recorded (${profile.academicYear.trim()}, ${profile.currentSemesterOrYear.trim()})`
    );
  } else {
    academicIncomplete.push('Add academic year and current semester/year to profile');
    academicDeductions.push('Academic year or current semester is missing (-3 pts).');
  }

  // B2. Qualifying marks percentage (6 pts) — from verified marksheet aggregate or profile
  const marksheetDocs = documents.filter((d) => {
    const ana = latestAnalysisByDoc.get(d.id);
    return (
      d.documentType.toLowerCase().includes('marksheet') ||
      (ana?.detectedType ?? '').toLowerCase().includes('marksheet') ||
      Boolean(ana?.marksheetSummary)
    );
  });

  const bestMarksheetDoc =
    marksheetDocs.find((d) => d.processingStatus === 'Completed') ??
    marksheetDocs.find((d) => d.processingStatus === 'Needs Review') ??
    marksheetDocs[0];
  const bestMarksheetAnalysis = bestMarksheetDoc
    ? latestAnalysisByDoc.get(bestMarksheetDoc.id)
    : undefined;
  const extractedPercent = bestMarksheetAnalysis?.marksheetSummary?.mainAggregate?.percentage;

  if (typeof extractedPercent === 'number') {
    academicPoints += 6;
    const msAgg = bestMarksheetAnalysis!.marksheetSummary!.mainAggregate!;
    const provLabel = msAgg.sourceType === 'ai-calculated' ? 'AI-Calculated' : 'Document-Extracted';
    academicCompleted.push(
      `Marksheet main aggregate available: ${msAgg.percentage}% (${msAgg.obtainedMarks}/${msAgg.maximumMarks}, ${provLabel})`
    );
  } else if (typeof profile?.previousMarksPercent === 'number') {
    academicPoints += 6;
    academicCompleted.push(
      `Previous qualifying marks recorded in profile (${profile.previousMarksPercent}%)`
    );
  } else {
    academicIncomplete.push('Provide previous qualifying marks (%) or upload a readable marksheet');
    academicDeductions.push('Previous qualifying academic percentage is unavailable (-6 pts).');
  }

  // B3. Marksheet extraction & verification status (8 pts)
  if (!bestMarksheetDoc) {
    academicIncomplete.push('Upload Previous Academic Marksheet for Document Intelligence verification');
    academicDeductions.push('No Academic Marksheet uploaded for verification (-8 pts).');
  } else if (
    bestMarksheetDoc.processingStatus === 'Completed' &&
    bestMarksheetAnalysis?.readabilityStatus === 'Readable' &&
    bestMarksheetAnalysis?.marksheetSummary &&
    !bestMarksheetAnalysis.marksheetSummary.requiresUserConfirmation
  ) {
    academicPoints += 8;
    academicCompleted.push(
      `Academic Marksheet verified (${bestMarksheetAnalysis.marksheetSummary.confirmationStatus})`
    );
  } else if (
    bestMarksheetDoc.processingStatus === 'Needs Review' ||
    bestMarksheetAnalysis?.marksheetSummary?.requiresUserConfirmation ||
    bestMarksheetAnalysis?.readabilityStatus === 'Partially Readable'
  ) {
    academicPoints += 4;
    const reason =
      bestMarksheetAnalysis?.marksheetSummary?.requiresUserConfirmation
        ? 'Subject selection / board aggregate rule confirmation is still pending.'
        : 'Uploaded marksheet requires manual review or clearer readability.';
    academicIncomplete.push(`Confirm or clarify Academic Marksheet (${bestMarksheetDoc.fileName})`);
    academicDeductions.push(`${reason} (-4 pts).`);
  } else if (
    bestMarksheetDoc.processingStatus === 'Pending' ||
    bestMarksheetDoc.processingStatus === 'Processing'
  ) {
    academicPoints += 1;
    academicIncomplete.push(`Wait for or trigger analysis on ${bestMarksheetDoc.fileName}`);
    academicDeductions.push('Uploaded marksheet has not completed analysis yet (-7 pts).');
  } else {
    academicIncomplete.push(`Re-upload a readable Academic Marksheet (current file ${bestMarksheetDoc.fileName} failed/unreadable)`);
    academicDeductions.push(
      `Uploaded marksheet (${bestMarksheetDoc.fileName}) is unreadable or failed processing (-8 pts).`
    );
  }

  const academicPercent = Math.round(
    (academicPoints / READINESS_SCORING_CONFIG.weights.academic) * 100
  );
  const academicDimension: ReadinessDimensionScore = {
    key: 'academic',
    label: 'Academic Readiness',
    weightPercent: READINESS_SCORING_CONFIG.weights.academic,
    maxPoints: READINESS_SCORING_CONFIG.weights.academic,
    earnedPoints: round2(academicPoints),
    scorePercent: academicPercent,
    status: classifyDimensionStatus(academicPercent),
    summary:
      bestMarksheetAnalysis?.marksheetSummary?.mainAggregate
        ? `Main aggregate ${bestMarksheetAnalysis.marksheetSummary.mainAggregate.percentage}% · ${bestMarksheetAnalysis.marksheetSummary.confirmationStatus}`
        : typeof profile?.previousMarksPercent === 'number'
          ? `Profile marks ${profile.previousMarksPercent}% · Marksheet verification ${bestMarksheetDoc ? bestMarksheetDoc.processingStatus || 'Pending' : 'Missing'}`
          : 'Academic marks and marksheet verification are incomplete.',
    completedRequirements: academicCompleted,
    incompleteRequirements: academicIncomplete,
    deductionReasons: academicDeductions,
  };

  // =========================================================================
  // Check Empty Scholarship Database Guardrail
  // =========================================================================
  const activeScholarships = scholarships.filter((s) => s.verificationStatus !== 'Archived');
  if (activeScholarships.length === 0) {
    const dataAvailabilityWarning =
      'Scholarship database is currently empty. Readiness scoring against real scheme rules and required documents cannot be completed until verified scholarship records exist.';
    const emptyDocDim: ReadinessDimensionScore = {
      key: 'documents',
      label: 'Document Readiness',
      weightPercent: READINESS_SCORING_CONFIG.weights.documents,
      maxPoints: READINESS_SCORING_CONFIG.weights.documents,
      earnedPoints: 0,
      scorePercent: null,
      status: 'Unavailable',
      summary: 'Cannot evaluate scholarship-specific documents while scholarship database is empty.',
      completedRequirements: [],
      incompleteRequirements: ['Seed or publish verified scholarship records in the database'],
      deductionReasons: ['Missing dependency: scholarships collection is empty.'],
    };
    const emptyEligDim: ReadinessDimensionScore = {
      key: 'eligibility',
      label: 'Eligibility Readiness',
      weightPercent: READINESS_SCORING_CONFIG.weights.eligibility,
      maxPoints: READINESS_SCORING_CONFIG.weights.eligibility,
      earnedPoints: 0,
      scorePercent: null,
      status: 'Unavailable',
      summary: 'No scholarships in database to evaluate deterministic eligibility.',
      completedRequirements: [],
      incompleteRequirements: ['Verify scholarship catalog availability'],
      deductionReasons: ['Missing dependency: scholarships collection is empty.'],
    };
    const emptyAppDim: ReadinessDimensionScore = {
      key: 'application',
      label: 'Application Readiness',
      weightPercent: READINESS_SCORING_CONFIG.weights.application,
      maxPoints: READINESS_SCORING_CONFIG.weights.application,
      earnedPoints: 0,
      scorePercent: null,
      status: 'Unavailable',
      summary: 'Application readiness unavailable without scholarship targets.',
      completedRequirements: [],
      incompleteRequirements: [],
      deductionReasons: ['Missing dependency: scholarships collection is empty.'],
    };

    const actions: ReadinessActionItem[] = profileIncomplete.length > 0
      ? [
          {
            id: 'act-complete-profile-empty-db',
            title: 'Complete missing student profile fields',
            explanation: `Complete ${profileIncomplete.length} missing profile field(s) (${profileIncomplete.slice(0, 4).join(', ')}) so eligibility can run automatically once scholarships are loaded.`,
            unblocksCount: 0,
            priority: 'High',
            status: 'Pending',
            sourceOfRequirement: 'Student Profile',
            suggestedNextStep: 'Open Profile & Onboarding to fill in missing fields.',
            actionRoute: '/profile',
          },
        ]
      : [];

    return {
      algorithmVersion: READINESS_ALGORITHM_VERSION,
      assessedAt,
      dataFingerprint,
      assessmentStatus: 'No Scholarship Data',
      overallScore: null,
      readinessPercent: 0,
      profileCompletenessPercent,
      documentCoveragePercent: 0,
      scholarshipsAvailableCount: 0,
      dataAvailabilityWarning,
      disclaimer: READINESS_DISCLAIMER,
      dimensionScores: [profileDimension, academicDimension, emptyDocDim, emptyEligDim, emptyAppDim],
      completedRequirements: [...academicCompleted, ...profileCompleted.map((f) => `Profile: ${f}`)],
      incompleteRequirements: [...profileIncomplete, ...academicIncomplete],
      deductionReasons: [dataAvailabilityWarning, ...profileDeductions, ...academicDeductions],
      missingProfileFields: profileIncomplete,
      missingDocuments: [],
      flaggedDocuments: [],
      scholarshipReadiness: [],
      recommendedActions: actions,
    };
  }

  // =========================================================================
  // Evaluate Per-Scholarship Eligibility + Document Comparison + Readiness
  // =========================================================================
  const savedSet = new Set(savedScholarships.map((s) => s.scholarshipId));
  const appByScholarship = new Map<string, ApplicationRecord>();
  const sortedApps = [...applications].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  sortedApps.forEach((a) => {
    const existing = appByScholarship.get(a.scholarshipId);
    if (!existing) {
      appByScholarship.set(a.scholarshipId, a);
    } else if (!isActiveApplicationStatus(existing.status) && isActiveApplicationStatus(a.status)) {
      appByScholarship.set(a.scholarshipId, a);
    }
  });

  const perScholarshipItems: ScholarshipSpecificReadiness[] = activeScholarships.map((s) => {
    const det = evaluateDeterministicEligibility(profile, s, referenceDate);
    const docReport = compareDocumentsAgainstScholarship(s, documents, documentAnalyses, profile);
    const appRec = appByScholarship.get(s.id);
    const isSaved = savedSet.has(s.id);
    const isSourceVerified = isScholarshipSourceVerified(s.verificationStatus);

    const availableDocs = docReport.items
      .filter((i) => i.status === 'Ready')
      .map((i) => i.requiredDocument);
    const needsReviewDocs = docReport.items
      .filter((i) => i.status === 'Needs Review' || i.status === 'Processing' || i.status === 'Failed')
      .map((i) => `${i.requiredDocument} (${i.status})`);
    const missingDocs = docReport.items
      .filter((i) => i.status === 'Missing')
      .map((i) => i.requiredDocument);

    let readinessPercent: number | null = null;
    let readinessLabel: ScholarshipSpecificReadiness['readinessLabel'];
    let nextRecommendedAction = '';

    if (det.overallStatus === 'Not Eligible') {
      readinessPercent = 0;
      readinessLabel = 'Not Eligible';
      nextRecommendedAction = `Not eligible due to: ${det.failedCriteria.join(', ')}. Review other matching schemes.`;
    } else if (det.overallStatus === 'Scholarship Status Unverified') {
      readinessPercent = null;
      readinessLabel = 'Status Unverified';
      nextRecommendedAction = `Official scholarship verification is "${s.verificationStatus}". Confirm current guidelines on official portal before preparing documents.`;
    } else if (det.overallStatus === 'Insufficient Information') {
      readinessPercent = null;
      readinessLabel = 'Blocked — Missing Info';
      nextRecommendedAction =
        det.missingProfileFields.length > 0
          ? `Complete missing profile fields (${det.missingProfileFields.map((f) => f.label).join(', ')}) to confirm eligibility.`
          : 'Complete missing profile information to evaluate eligibility.';
    } else {
      // Eligible or Potentially Eligible
      const eligFactor =
        det.overallStatus === 'Eligible'
          ? 100
          : Math.max(40, det.compatibilityScore);
      const docFactor = docReport.hasPublishedRequirements
        ? docReport.readinessPercent
        : 50; // Neutral if scholarship does not publish structured checklist
      const normStatus = appRec ? normalizeApplicationStatus(appRec.status) : null;
      const trackerFactor =
        normStatus === 'Submitted' || normStatus === 'Under Review' || normStatus === 'Approved'
          ? 100
          : normStatus === 'Ready to Apply'
            ? 85
            : normStatus === 'Correction Required'
              ? 70
              : normStatus === 'Preparing' || normStatus === 'Documents Pending'
                ? 65
                : normStatus === 'Interested'
                  ? 50
                  : normStatus === 'Withdrawn' || normStatus === 'Rejected' || normStatus === 'Closed'
                    ? 25
                    : isSaved
                      ? 40
                      : 20;

      readinessPercent = Math.round(eligFactor * 0.4 + docFactor * 0.45 + trackerFactor * 0.15);

      if (det.overallStatus === 'Potentially Eligible') {
        readinessPercent = Math.min(readinessPercent, 82);
        readinessLabel = missingDocs.length === 0 && needsReviewDocs.length === 0 ? 'Nearly Ready' : 'Preparation Needed';
        nextRecommendedAction =
          det.missingProfileFields.length > 0
            ? `Resolve unknown eligibility fields (${det.missingProfileFields.map((f) => f.label).join(', ')}) and prepare missing documents.`
            : `Prepare ${missingDocs.length} missing document(s) and confirm remaining criteria.`;
      } else if (missingDocs.length === 0 && needsReviewDocs.length === 0 && det.effectiveApplicationStatus !== 'Status unknown') {
        readinessLabel = readinessPercent >= 80 ? 'Application Ready' : 'Nearly Ready';
        nextRecommendedAction = appRec
          ? normStatus === 'Submitted' || normStatus === 'Under Review' || normStatus === 'Approved'
            ? `Application status is "${normStatus}". Monitor portal updates.`
            : normStatus === 'Correction Required'
              ? 'Application requires correction. Inspect TrustGuard/documents and resubmit on the official portal.'
              : 'All required documents are ready. Proceed to the official portal to submit and record your reference ID.'
          : 'All eligibility rules and documents match. Add to Application Tracker and submit on the official portal.';
      } else if (missingDocs.length === 0 && needsReviewDocs.length === 0) {
        readinessLabel = 'Nearly Ready';
        nextRecommendedAction =
          'Documents and eligibility rules pass; verify current academic cycle dates on the official portal before applying.';
      } else {
        readinessLabel = readinessPercent >= 65 ? 'Nearly Ready' : 'Preparation Needed';
        nextRecommendedAction =
          missingDocs.length > 0
            ? `Upload missing document(s): ${missingDocs.slice(0, 3).join(', ')}.`
            : `Review flagged document(s): ${needsReviewDocs.slice(0, 2).join(', ')}.`;
      }
    }

    return {
      scholarshipId: s.id,
      scholarshipTitle: s.title,
      provider: s.provider,
      scholarshipType: s.scholarshipType,
      verificationStatus: s.verificationStatus,
      isSourceVerified,
      officialUrl: s.officialUrl || s.officialSourceUrl || '',
      applicationDeadline: s.applicationDeadline || 'Check Official Portal',
      effectiveApplicationStatus: det.effectiveApplicationStatus,
      eligibilityStatus: det.overallStatus,
      compatibilityScore: det.compatibilityScore,
      readinessPercent,
      readinessLabel,
      requiredDocuments: s.requiredDocuments ?? [],
      availableDocuments: availableDocs,
      needsReviewDocuments: needsReviewDocs,
      missingDocuments: missingDocs,
      failedCriteria: det.failedCriteria,
      unknownCriteria: det.unknownCriteria,
      missingProfileFields: det.missingProfileFields.map((f) => f.label),
      trackerStatus: appRec?.status ?? 'Not Tracked',
      nextRecommendedAction,
      isSaved,
    };
  });

  // Sort scholarship-specific items: Eligible/Potentially Eligible/Tracked/Saved first, Not Eligible last
  perScholarshipItems.sort((a, b) => {
    const rank = (item: ScholarshipSpecificReadiness): number => {
      if (item.eligibilityStatus === 'Eligible') return 5;
      if (item.eligibilityStatus === 'Potentially Eligible') return 4;
      if (item.eligibilityStatus === 'Insufficient Information') return 3;
      if (item.eligibilityStatus === 'Scholarship Status Unverified') return 2;
      return 1;
    };
    const rDiff = rank(b) - rank(a);
    if (rDiff !== 0) return rDiff;
    const trackDiff = (b.trackerStatus !== 'Not Tracked' ? 1 : 0) - (a.trackerStatus !== 'Not Tracked' ? 1 : 0);
    if (trackDiff !== 0) return trackDiff;
    return (b.readinessPercent ?? -1) - (a.readinessPercent ?? -1);
  });

  // Relevant target pool for aggregate Document / Eligibility / Application dimensions
  const eligibleOrPotential = perScholarshipItems.filter(
    (s) =>
      s.eligibilityStatus === 'Eligible' ||
      s.eligibilityStatus === 'Potentially Eligible'
  );
  const trackedOrSavedEligible = perScholarshipItems.filter(
    (s) =>
      (s.trackerStatus !== 'Not Tracked' || s.isSaved) &&
      s.eligibilityStatus !== 'Not Eligible'
  );
  const docTargetPool =
    trackedOrSavedEligible.length > 0
      ? trackedOrSavedEligible
      : eligibleOrPotential.length > 0
        ? eligibleOrPotential
        : perScholarshipItems.filter((s) => s.eligibilityStatus !== 'Not Eligible').slice(0, 5);

  // =========================================================================
  // Dimension C: Document Readiness (25 pts) — only against actual relevant scholarship checklists
  // =========================================================================
  const docRequirementStatus = new Map<
    string,
    { status: 'Ready' | 'Needs Review' | 'Missing'; scholarships: string[] }
  >();

  for (const sch of docTargetPool) {
    const schObj = activeScholarships.find((x) => x.id === sch.scholarshipId);
    if (!schObj) continue;
    const report = compareDocumentsAgainstScholarship(schObj, documents, documentAnalyses, profile);
    for (const item of report.items) {
      const existing = docRequirementStatus.get(item.requiredDocument);
      const mappedStatus: 'Ready' | 'Needs Review' | 'Missing' =
        item.status === 'Ready'
          ? 'Ready'
          : item.status === 'Missing' || item.status === 'Failed'
            ? 'Missing'
            : 'Needs Review';
      if (!existing) {
        docRequirementStatus.set(item.requiredDocument, {
          status: mappedStatus,
          scholarships: [sch.scholarshipTitle],
        });
      } else {
        if (!existing.scholarships.includes(sch.scholarshipTitle)) {
          existing.scholarships.push(sch.scholarshipTitle);
        }
        // Prefer strongest verified state if already matched cleanly
        if (existing.status === 'Missing' && mappedStatus !== 'Missing') {
          existing.status = mappedStatus;
        } else if (existing.status === 'Needs Review' && mappedStatus === 'Ready') {
          existing.status = 'Ready';
        }
      }
    }
  }

  const docCompleted: string[] = [];
  const docIncomplete: string[] = [];
  const docDeductions: string[] = [];
  const missingDocuments: string[] = [];
  const flaggedDocuments: string[] = [];

  let docCreditSum = 0;
  docRequirementStatus.forEach((info, docName) => {
    if (info.status === 'Ready') {
      docCreditSum += 1;
      docCompleted.push(`Verified & readable: ${docName}`);
    } else if (info.status === 'Needs Review') {
      docCreditSum += 0.35;
      flaggedDocuments.push(`${docName} (needs review / clarification)`);
      docIncomplete.push(`Review flagged document: ${docName}`);
      docDeductions.push(
        `Document "${docName}" is uploaded but needs readability/field review (partial credit only).`
      );
    } else {
      missingDocuments.push(docName);
      docIncomplete.push(`Upload & analyze ${docName}`);
      docDeductions.push(
        `Missing required document "${docName}" needed for ${info.scholarships.length} relevant scheme(s).`
      );
    }
  });

  const trustGuardCheck = evaluateTrustGuardVerification({
    userId: profile?.uid ?? documents[0]?.userId ?? 'student',
    profile,
    documents,
    documentAnalyses,
    scholarships,
    savedScholarships,
    applications,
    referenceDate,
  });
  const tgCriticalOrHighFindings = trustGuardCheck.findings.filter(
    (f) => f.severity === 'Critical' || f.severity === 'High'
  );

  for (const finding of tgCriticalOrHighFindings.slice(0, 4)) {
    flaggedDocuments.push(`TrustGuard (${finding.severity}): ${finding.title}`);
  }

  const totalUniqueDocs = docRequirementStatus.size;
  const rawDocEarnedPoints =
    totalUniqueDocs > 0
      ? round2((docCreditSum / totalUniqueDocs) * READINESS_SCORING_CONFIG.weights.documents)
      : 0;

  const tgPenalty =
    totalUniqueDocs > 0 && tgCriticalOrHighFindings.length > 0
      ? Math.min(rawDocEarnedPoints, tgCriticalOrHighFindings.length * 3)
      : 0;
  const docEarnedPoints = round2(Math.max(0, rawDocEarnedPoints - tgPenalty));
  const documentCoveragePercent =
    totalUniqueDocs > 0
      ? Math.max(0, Math.round((docEarnedPoints / READINESS_SCORING_CONFIG.weights.documents) * 100))
      : 0;

  if (tgCriticalOrHighFindings.length > 0) {
    docIncomplete.push(
      `Resolve ${tgCriticalOrHighFindings.length} TrustGuard Critical/High consistency issue(s)`
    );
    docDeductions.push(
      `TrustGuard detected ${tgCriticalOrHighFindings.length} Critical/High document consistency or readability risk(s) (-${tgPenalty} pts until verified).`
    );
  }

  const docDimension: ReadinessDimensionScore = {
    key: 'documents',
    label: 'Document Readiness',
    weightPercent: READINESS_SCORING_CONFIG.weights.documents,
    maxPoints: READINESS_SCORING_CONFIG.weights.documents,
    earnedPoints: docEarnedPoints,
    scorePercent: totalUniqueDocs > 0 ? documentCoveragePercent : null,
    status: classifyDimensionStatus(totalUniqueDocs > 0 ? documentCoveragePercent : null),
    summary:
      totalUniqueDocs > 0
        ? `${docCompleted.length} ready, ${flaggedDocuments.length} flagged for review, ${missingDocuments.length} missing across ${docTargetPool.length} relevant scholarship(s).`
        : 'No structured required-document checklist published for target schemes.',
    completedRequirements: docCompleted,
    incompleteRequirements: docIncomplete,
    deductionReasons: docDeductions,
  };

  // =========================================================================
  // Dimension D: Eligibility Readiness (20 pts)
  // =========================================================================
  const verifiedActive = perScholarshipItems.filter(
    (s) =>
      s.isSourceVerified &&
      s.effectiveApplicationStatus !== 'Closed' &&
      s.effectiveApplicationStatus !== 'Expired'
  );
  const eligibleCount = verifiedActive.filter((s) => s.eligibilityStatus === 'Eligible').length;
  const potentialCount = verifiedActive.filter(
    (s) => s.eligibilityStatus === 'Potentially Eligible'
  ).length;
  const insufficientCount = verifiedActive.filter(
    (s) => s.eligibilityStatus === 'Insufficient Information'
  ).length;
  const notEligibleCount = verifiedActive.filter(
    (s) => s.eligibilityStatus === 'Not Eligible'
  ).length;

  let eligPoints = 0;
  const eligCompleted: string[] = [];
  const eligIncomplete: string[] = [];
  const eligDeductions: string[] = [];

  if (eligibleCount > 0) {
    eligPoints += 10;
    eligCompleted.push(`${eligibleCount} verified scholarship(s) confirmed Eligible`);
  } else if (potentialCount > 0) {
    eligPoints += 5;
    eligIncomplete.push(
      `Resolve unknown criteria to upgrade ${potentialCount} Potentially Eligible scholarship(s) to Eligible`
    );
    eligDeductions.push(
      'No verified scholarship is 100% Eligible yet (-5 pts until unknown criteria are confirmed).'
    );
  } else if (insufficientCount > 0) {
    eligDeductions.push(
      'Eligibility cannot be confirmed for active schemes due to missing profile fields (-10 pts).'
    );
    eligIncomplete.push('Complete missing profile fields to run deterministic eligibility');
  } else {
    eligDeductions.push(
      `All ${notEligibleCount} active verified scholarships failed mandatory eligibility rules (-10 pts).`
    );
  }

  // Criteria resolution rate across verified active schemes (excluding Not Eligible mandatory fails from rewarding points)
  const poolForCriteria =
    eligibleOrPotential.length > 0
      ? eligibleOrPotential
      : verifiedActive.filter((s) => s.eligibilityStatus !== 'Not Eligible');

  let criteriaPassed = 0;
  let criteriaTotal = 0;
  for (const s of poolForCriteria) {
    const schObj = activeScholarships.find((x) => x.id === s.scholarshipId);
    if (!schObj) continue;
    const det = evaluateDeterministicEligibility(profile, schObj, referenceDate);
    const relevantCriteria = det.criteriaBreakdown.filter(
      (c) =>
        c.status !== 'Not Applicable' &&
        c.criterion !== 'Verification Status' &&
        c.criterion !== 'Application Window'
    );
    criteriaTotal += relevantCriteria.length;
    criteriaPassed += relevantCriteria.filter((c) => c.status === 'Passed').length;
  }

  if (criteriaTotal > 0) {
    const criteriaRatio = criteriaPassed / criteriaTotal;
    eligPoints += round2(criteriaRatio * 10);
    if (criteriaPassed < criteriaTotal) {
      const unresolved = criteriaTotal - criteriaPassed;
      eligDeductions.push(
        `${unresolved} of ${criteriaTotal} eligibility criteria across active candidate schemes remain Unknown/unresolved.`
      );
    }
  } else if (eligibleCount === 0 && notEligibleCount > 0) {
    eligDeductions.push('No eligible active schemes match current profile criteria (-10 pts).');
  }

  if (eligibilityAssessments.length > 0) {
    eligCompleted.push(`${eligibilityAssessments.length} saved eligibility assessment(s) on record`);
  }

  const eligPercent = Math.round(
    (eligPoints / READINESS_SCORING_CONFIG.weights.eligibility) * 100
  );
  const eligDimension: ReadinessDimensionScore = {
    key: 'eligibility',
    label: 'Eligibility Readiness',
    weightPercent: READINESS_SCORING_CONFIG.weights.eligibility,
    maxPoints: READINESS_SCORING_CONFIG.weights.eligibility,
    earnedPoints: round2(eligPoints),
    scorePercent: eligPercent,
    status: classifyDimensionStatus(eligPercent),
    summary: `${eligibleCount} Eligible · ${potentialCount} Potentially Eligible · ${insufficientCount} Insufficient Info · ${notEligibleCount} Not Eligible`,
    completedRequirements: eligCompleted,
    incompleteRequirements: eligIncomplete,
    deductionReasons: eligDeductions,
  };

  // =========================================================================
  // Dimension E: Application Readiness (15 pts)
  // =========================================================================
  let appPoints = 0;
  const appCompleted: string[] = [];
  const appIncomplete: string[] = [];
  const appDeductions: string[] = [];

  const eligibleTrackedOrSaved = perScholarshipItems.filter(
    (s) =>
      (s.eligibilityStatus === 'Eligible' || s.eligibilityStatus === 'Potentially Eligible') &&
      (s.trackerStatus !== 'Not Tracked' || s.isSaved)
  );

  // E1. Shortlist / Tracker engagement on eligible schemes (5 pts)
  if (eligibleTrackedOrSaved.length > 0) {
    appPoints += 5;
    appCompleted.push(
      `${eligibleTrackedOrSaved.length} eligible/potential scholarship(s) saved or tracked`
    );
  } else if (eligibleOrPotential.length > 0) {
    appIncomplete.push('Save or add an eligible scholarship to your Application Tracker');
    appDeductions.push('No eligible scholarship has been saved or added to the Application Tracker (-5 pts).');
  } else {
    appDeductions.push('No eligible scholarship targets available to prepare applications (-5 pts).');
  }

  // E2. Official portal & cycle date clarity (5 pts)
  const appTargets =
    eligibleTrackedOrSaved.length > 0 ? eligibleTrackedOrSaved : eligibleOrPotential.slice(0, 3);
  if (appTargets.length > 0) {
    const withVerifiedUrl = appTargets.filter((t) => t.isSourceVerified && t.officialUrl).length;
    const withKnownWindow = appTargets.filter(
      (t) => t.effectiveApplicationStatus === 'Currently accepting applications' || t.effectiveApplicationStatus === 'Upcoming'
    ).length;
    const urlPts = round2((withVerifiedUrl / appTargets.length) * 3);
    const windowPts = round2((withKnownWindow / appTargets.length) * 2);
    appPoints += urlPts + windowPts;
    if (withKnownWindow < appTargets.length) {
      appIncomplete.push('Confirm active cycle deadlines on official portals for target scholarships');
      appDeductions.push(
        `${appTargets.length - withKnownWindow} target scheme(s) have "Status unknown" cycle dates requiring official portal verification.`
      );
    } else {
      appCompleted.push('Official portal links and cycle windows verified for target scholarships');
    }
  }

  // E3. Application Tracker execution progress (5 pts)
  const activeApps = applications.filter((a) => {
    const match = perScholarshipItems.find((p) => p.scholarshipId === a.scholarshipId);
    return match ? match.eligibilityStatus !== 'Not Eligible' : true;
  });

  if (activeApps.length > 0) {
    const bestProgressRatio = Math.max(
      ...activeApps.map((a) => {
        const st = normalizeApplicationStatus(a.status);
        if (st === 'Submitted' || st === 'Under Review' || st === 'Approved') return 1;
        if (st === 'Ready to Apply') return 0.85;
        if (st === 'Correction Required') return 0.55;
        if (st === 'Preparing' || st === 'Documents Pending') return 0.5;
        if (st === 'Interested') return 0.35;
        return 0.15;
      })
    );
    appPoints += round2(bestProgressRatio * 5);
    appCompleted.push(
      `Application tracker active (${activeApps.length} tracked; highest stage: ${normalizeApplicationStatus(activeApps[0].status)})`
    );
    if (bestProgressRatio < 1) {
      appIncomplete.push('Advance tracked scholarship application(s) toward submission & record portal reference ID');
      appDeductions.push('Tracked application(s) are not yet submitted on the official portal.');
    }
  } else {
    appIncomplete.push('Create an application entry in the Tracker once documents are prepared');
    appDeductions.push('No active applications tracked in Application Tracker (-5 pts).');
  }

  const appPercent = Math.round(
    (appPoints / READINESS_SCORING_CONFIG.weights.application) * 100
  );
  const appDimension: ReadinessDimensionScore = {
    key: 'application',
    label: 'Application Readiness',
    weightPercent: READINESS_SCORING_CONFIG.weights.application,
    maxPoints: READINESS_SCORING_CONFIG.weights.application,
    earnedPoints: round2(appPoints),
    scorePercent: appPercent,
    status: classifyDimensionStatus(appPercent),
    summary:
      activeApps.length > 0
        ? `${activeApps.length} application(s) tracked · ${eligibleTrackedOrSaved.length} eligible targets shortlisted`
        : 'No application tracker workflows started for eligible schemes yet.',
    completedRequirements: appCompleted,
    incompleteRequirements: appIncomplete,
    deductionReasons: appDeductions,
  };

  const dimensionScores = [
    profileDimension,
    academicDimension,
    docDimension,
    eligDimension,
    appDimension,
  ];

  // =========================================================================
  // Determine Overall Score & Assessment Completeness
  // =========================================================================
  const hasMinimalInformation =
    Boolean(profile) &&
    (Boolean(profile?.onboardingCompleted) ||
      profileCompleted.length >= 4 ||
      documents.length > 0);

  let assessmentStatus: ReadinessAssessmentStatus;
  let overallScore: number | null;
  let readinessPercent = 0;

  if (!hasMinimalInformation) {
    assessmentStatus = 'Assessment Incomplete';
    overallScore = null;
    readinessPercent = 0;
  } else {
    const rawTotal = dimensionScores.reduce((sum, d) => sum + d.earnedPoints, 0);
    overallScore = Math.min(100, Math.max(0, Math.round(rawTotal)));
    readinessPercent = overallScore;

    if (
      overallScore >= READINESS_SCORING_CONFIG.thresholds.ready &&
      eligibleCount > 0 &&
      flaggedDocuments.length === 0
    ) {
      assessmentStatus = 'Ready';
    } else if (overallScore >= READINESS_SCORING_CONFIG.thresholds.partiallyReady) {
      assessmentStatus = 'Partially Ready';
    } else {
      assessmentStatus = 'Needs Preparation';
    }
  }

  // =========================================================================
  // Personalized Action Plan (Prioritized by unblocksCount & severity)
  // =========================================================================
  const previousStatusById = new Map<string, ReadinessActionStatus>();
  previousActions.forEach((a) => previousStatusById.set(a.id, a.status));

  const generatedActions: ReadinessActionItem[] = [];

  // 1. Missing profile fields affecting Unknown eligibility criteria
  const missingFieldImpact = new Map<string, string[]>();
  for (const s of perScholarshipItems) {
    for (const fieldLabel of s.missingProfileFields) {
      const list = missingFieldImpact.get(fieldLabel) ?? [];
      list.push(s.scholarshipTitle);
      missingFieldImpact.set(fieldLabel, list);
    }
  }

  missingFieldImpact.forEach((schemeTitles, fieldLabel) => {
    const actionId = `act-profile-${fieldLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const prevStatus = previousStatusById.get(actionId);
    generatedActions.push({
      id: actionId,
      title: `Complete profile field: ${fieldLabel}`,
      explanation: `Missing "${fieldLabel}" currently leaves eligibility Unknown for ${schemeTitles.length} scholarship(s).`,
      relatedScholarshipTitle: schemeTitles.slice(0, 2).join(', '),
      unblocksCount: schemeTitles.length,
      priority: schemeTitles.length >= 3 ? 'High' : 'Medium',
      status: prevStatus === 'In Progress' ? 'In Progress' : 'Pending',
      sourceOfRequirement: 'Profile & Deterministic Eligibility Engine',
      suggestedNextStep: `Open Profile & Onboarding, enter your ${fieldLabel}, and save to recalculate eligibility.`,
      actionRoute: '/profile',
    });
  });

  // 2. Flagged / unreadable / unconfirmed marksheet or documents
  if (bestMarksheetDoc && bestMarksheetAnalysis?.marksheetSummary?.requiresUserConfirmation) {
    const id = 'act-confirm-marksheet';
    generatedActions.push({
      id,
      title: 'Confirm Academic Marksheet subject selection & aggregate',
      explanation:
        bestMarksheetAnalysis.marksheetSummary.confirmationReasons[0] ||
        'Marksheet subject roles or board aggregate rules need confirmation before finalizing percentage.',
      unblocksCount: eligibleOrPotential.length || 1,
      priority: 'High',
      status: previousStatusById.get(id) === 'In Progress' ? 'In Progress' : 'Pending',
      sourceOfRequirement: 'Document Intelligence (Marksheet Calculator)',
      suggestedNextStep: 'Open Document Intelligence, inspect the subject table, and confirm main vs. additional subjects.',
      actionRoute: '/documents',
    });
  }

  docRequirementStatus.forEach((info, docName) => {
    if (info.status === 'Missing') {
      const id = `act-upload-${docName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const priority: ReadinessActionPriority = info.scholarships.length >= 2 ? 'High' : 'Medium';
      generatedActions.push({
        id,
        title: `Upload & analyze ${docName}`,
        explanation: `Required by ${info.scholarships.length} relevant scholarship(s) (${info.scholarships.slice(0, 2).join(', ')}).`,
        relatedScholarshipTitle: info.scholarships[0],
        unblocksCount: info.scholarships.length,
        priority,
        status: previousStatusById.get(id) === 'In Progress' ? 'In Progress' : 'Pending',
        sourceOfRequirement: 'Scholarship Document Checklist',
        suggestedNextStep: `Upload a clear PDF or image of your ${docName} in Document Intelligence and run AI extraction.`,
        actionRoute: '/documents',
      });
    } else if (info.status === 'Needs Review') {
      const id = `act-review-${docName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      generatedActions.push({
        id,
        title: `Resolve document review issues for ${docName}`,
        explanation: `Uploaded ${docName} is flagged for readability, missing fields, expiry, or profile mismatch across ${info.scholarships.length} scheme(s).`,
        relatedScholarshipTitle: info.scholarships[0],
        unblocksCount: info.scholarships.length,
        priority: 'High',
        status: previousStatusById.get(id) === 'In Progress' ? 'In Progress' : 'Pending',
        sourceOfRequirement: 'Document Intelligence Verification',
        suggestedNextStep: `Inspect the extracted fields and mismatch warnings for ${docName} in Document Intelligence and re-upload a clearer scan if needed.`,
        actionRoute: '/documents',
      });
    }
  });

  if (tgCriticalOrHighFindings.length > 0) {
    const id = 'act-trustguard-resolve';
    const topFinding = tgCriticalOrHighFindings[0];
    generatedActions.push({
      id,
      title: `Resolve ${tgCriticalOrHighFindings.length} TrustGuard document risk finding(s)`,
      explanation: `${topFinding.title}. ${topFinding.description}`,
      relatedScholarshipTitle: topFinding.relatedScholarshipTitles?.[0],
      unblocksCount: Math.max(1, topFinding.relatedScholarshipTitles?.length ?? 1),
      priority: 'High',
      status: previousStatusById.get(id) === 'In Progress' ? 'In Progress' : 'Pending',
      sourceOfRequirement: 'TrustGuard Document Verification Engine',
      suggestedNextStep: topFinding.recommendedAction,
      actionRoute: '/trustguard',
    });
  }

  // 3. Official deadline verification & application tracker next steps
  const unknownWindowTargets = perScholarshipItems.filter(
    (s) =>
      (s.eligibilityStatus === 'Eligible' || s.eligibilityStatus === 'Potentially Eligible') &&
      s.effectiveApplicationStatus === 'Status unknown'
  );
  if (unknownWindowTargets.length > 0) {
    const id = 'act-check-official-deadlines';
    generatedActions.push({
      id,
      title: 'Check official scholarship portal deadlines',
      explanation: `${unknownWindowTargets.length} matching scholarship(s) have seasonal ("Status unknown") cycle dates.`,
      relatedScholarshipTitle: unknownWindowTargets[0].scholarshipTitle,
      unblocksCount: unknownWindowTargets.length,
      priority: 'Medium',
      status: previousStatusById.get(id) === 'In Progress' ? 'In Progress' : 'Pending',
      sourceOfRequirement: 'Scholarship Verification Metadata',
      suggestedNextStep: `Visit the official portal (${unknownWindowTargets[0].officialUrl || 'NSP / State Portal'}) to confirm open dates before applying.`,
      actionRoute: `/scholarships/${unknownWindowTargets[0].scholarshipId}`,
    });
  }

  const readyToTrack = perScholarshipItems.filter(
    (s) => s.eligibilityStatus === 'Eligible' && s.trackerStatus === 'Not Tracked'
  );
  if (readyToTrack.length > 0) {
    const id = 'act-track-eligible-scheme';
    generatedActions.push({
      id,
      title: `Start tracking ${readyToTrack[0].scholarshipTitle}`,
      explanation: `You meet deterministic eligibility criteria for ${readyToTrack.length} verified scholarship(s) not yet added to your Application Tracker.`,
      relatedScholarshipId: readyToTrack[0].scholarshipId,
      relatedScholarshipTitle: readyToTrack[0].scholarshipTitle,
      unblocksCount: 1,
      priority: readyToTrack[0].missingDocuments.length === 0 ? 'High' : 'Low',
      status: previousStatusById.get(id) === 'In Progress' ? 'In Progress' : 'Pending',
      sourceOfRequirement: 'Application Tracker',
      suggestedNextStep: 'Open the scholarship detail page and click Track Application to manage your submission timeline.',
      actionRoute: `/scholarships/${readyToTrack[0].scholarshipId}`,
    });
  }

  // Sort actions: High priority first, then highest unblocksCount
  const priorityWeight: Record<ReadinessActionPriority, number> = { High: 3, Medium: 2, Low: 1 };
  generatedActions.sort((a, b) => {
    const pDiff = priorityWeight[b.priority] - priorityWeight[a.priority];
    if (pDiff !== 0) return pDiff;
    return b.unblocksCount - a.unblocksCount;
  });

  // Also include verified completed milestones strictly backed by DB state
  const completedRequirements = dimensionScores.flatMap((d) => d.completedRequirements);
  const incompleteRequirements = dimensionScores.flatMap((d) => d.incompleteRequirements);
  const deductionReasons = dimensionScores.flatMap((d) => d.deductionReasons);

  return {
    algorithmVersion: READINESS_ALGORITHM_VERSION,
    assessedAt,
    dataFingerprint,
    assessmentStatus,
    overallScore,
    readinessPercent,
    profileCompletenessPercent,
    documentCoveragePercent,
    scholarshipsAvailableCount: activeScholarships.length,
    disclaimer: READINESS_DISCLAIMER,
    dimensionScores,
    completedRequirements,
    incompleteRequirements,
    deductionReasons,
    missingProfileFields: profileIncomplete,
    missingDocuments,
    flaggedDocuments,
    scholarshipReadiness: perScholarshipItems,
    recommendedActions: generatedActions,
  };
}
