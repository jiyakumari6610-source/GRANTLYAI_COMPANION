import { compareDocumentsAgainstScholarship } from './documentComparison.ts';
import {
  evaluateDeterministicEligibility,
  isScholarshipSourceVerified,
  parseScholarshipDeadlineTimestamp,
  resolveApplicationCycleStatus,
} from './eligibilityEngine.ts';
import { evaluateTrustGuardVerification } from './trustguardEngine.ts';
import type {
  ApplicationChecklistItemRecord,
  ApplicationEventType,
  ApplicationRecord,
  ApplicationStatus,
  DocumentAnalysis,
  DocumentProcessingStatus,
  DocumentRecord,
  EligibilityOverallStatus,
  NotificationPreferenceRecord,
  NotificationRecord,
  Phase8ApplicationStatus,
  Scholarship,
  StudentProfile,
  TrustGuardDocumentAssessment,
  TrustGuardFinding,
} from '../types/database.ts';

export const PHASE8_APPLICATION_STATUSES: Phase8ApplicationStatus[] = [
  'Interested',
  'Preparing',
  'Documents Pending',
  'Ready to Apply',
  'Submitted',
  'Under Review',
  'Correction Required',
  'Approved',
  'Rejected',
  'Withdrawn',
  'Closed',
];

export const ACTIVE_PHASE8_STATUSES = new Set<Phase8ApplicationStatus>([
  'Interested',
  'Preparing',
  'Documents Pending',
  'Ready to Apply',
  'Submitted',
  'Under Review',
  'Correction Required',
]);

export const TERMINAL_PHASE8_STATUSES = new Set<Phase8ApplicationStatus>([
  'Approved',
  'Rejected',
  'Closed',
]);

export const EXTERNAL_PORTAL_NOTICE =
  'You are leaving GRANTLY AI to visit the official external scholarship portal. GRANTLY AI never collects portal passwords, OTPs, or bank PINs, and does not automatically submit applications on your behalf. Opening this link will not mark your application as Submitted.';

export function normalizeApplicationStatus(status: ApplicationStatus): Phase8ApplicationStatus {
  switch (status) {
    case 'Draft':
      return 'Preparing';
    case 'Documents Ready':
      return 'Ready to Apply';
    case 'Awarded':
      return 'Approved';
    default:
      return status;
  }
}

export function isActiveApplicationStatus(status: ApplicationStatus): boolean {
  return ACTIVE_PHASE8_STATUSES.has(normalizeApplicationStatus(status));
}

export const VALID_APPLICATION_TRANSITIONS: Record<
  Phase8ApplicationStatus,
  Phase8ApplicationStatus[]
> = {
  Interested: ['Preparing', 'Documents Pending', 'Withdrawn', 'Closed'],
  Preparing: ['Documents Pending', 'Ready to Apply', 'Interested', 'Withdrawn', 'Closed'],
  'Documents Pending': ['Preparing', 'Ready to Apply', 'Withdrawn', 'Closed'],
  'Ready to Apply': ['Submitted', 'Documents Pending', 'Preparing', 'Withdrawn', 'Closed'],
  Submitted: ['Under Review', 'Correction Required', 'Withdrawn', 'Closed'],
  'Under Review': ['Approved', 'Rejected', 'Correction Required', 'Withdrawn', 'Closed'],
  'Correction Required': [
    'Preparing',
    'Documents Pending',
    'Ready to Apply',
    'Submitted',
    'Under Review',
    'Withdrawn',
    'Closed',
  ],
  Approved: ['Closed'],
  Rejected: ['Closed'],
  Withdrawn: ['Preparing', 'Closed'],
  Closed: [],
};

export function getAllowedNextStatuses(currentStatus: ApplicationStatus): Phase8ApplicationStatus[] {
  const normalized = normalizeApplicationStatus(currentStatus);
  return VALID_APPLICATION_TRANSITIONS[normalized] ?? [];
}

export interface TransitionValidationInput {
  currentStatus: ApplicationStatus;
  nextStatus: ApplicationStatus;
  submissionConfirmed?: boolean;
  scholarshipExists?: boolean;
  scholarshipArchived?: boolean;
  deadlineExpired?: boolean;
}

export interface TransitionValidationResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;
  confirmationPrompt?: string;
  normalizedFrom: Phase8ApplicationStatus;
  normalizedTo: Phase8ApplicationStatus;
}

export function validateApplicationTransition(
  input: TransitionValidationInput
): TransitionValidationResult {
  const from = normalizeApplicationStatus(input.currentStatus);
  const to = normalizeApplicationStatus(input.nextStatus);

  if (from === to) {
    return {
      allowed: true,
      requiresConfirmation: false,
      normalizedFrom: from,
      normalizedTo: to,
    };
  }

  const allowedTargets = VALID_APPLICATION_TRANSITIONS[from] ?? [];
  if (!allowedTargets.includes(to)) {
    return {
      allowed: false,
      reason: `Invalid workflow transition: "${from}" cannot jump directly to "${to}". Allowed next stages: ${
        allowedTargets.length > 0 ? allowedTargets.join(', ') : 'None (terminal state)'
      }.`,
      requiresConfirmation: false,
      normalizedFrom: from,
      normalizedTo: to,
    };
  }

  if (to === 'Submitted') {
    if (input.scholarshipExists === false) {
      return {
        allowed: false,
        reason:
          'Cannot mark Submitted because the linked scholarship record no longer exists in the database.',
        requiresConfirmation: true,
        normalizedFrom: from,
        normalizedTo: to,
      };
    }
    if (input.scholarshipArchived) {
      return {
        allowed: false,
        reason:
          'Cannot mark Submitted because the linked scholarship record has been archived.',
        requiresConfirmation: true,
        normalizedFrom: from,
        normalizedTo: to,
      };
    }
    if (input.deadlineExpired) {
      return {
        allowed: false,
        reason:
          'Cannot mark Submitted because the scholarship deadline has already expired. Verify on the official portal or close/withdraw this tracker entry.',
        requiresConfirmation: true,
        normalizedFrom: from,
        normalizedTo: to,
      };
    }
    if (!input.submissionConfirmed) {
      return {
        allowed: false,
        reason:
          'Explicit student confirmation is required before recording a Submitted status. Opening an external URL never auto-submits an application.',
        requiresConfirmation: true,
        confirmationPrompt:
          'Confirm that you completed and submitted your application directly on the official scholarship portal.',
        normalizedFrom: from,
        normalizedTo: to,
      };
    }
  }

  if (from === 'Withdrawn' && to === 'Preparing' && input.deadlineExpired) {
    return {
      allowed: false,
      reason: 'Cannot reopen a Withdrawn application after the scholarship deadline has expired.',
      requiresConfirmation: false,
      normalizedFrom: from,
      normalizedTo: to,
    };
  }

  const confirmationTargets = new Set<Phase8ApplicationStatus>([
    'Submitted',
    'Correction Required',
    'Approved',
    'Rejected',
    'Withdrawn',
    'Closed',
  ]);

  const requiresConfirmation = confirmationTargets.has(to);
  let confirmationPrompt: string | undefined;
  if (to === 'Submitted') {
    confirmationPrompt =
      'Confirm that you personally submitted the form on the official portal and enter any acknowledgement/reference ID.';
  } else if (to === 'Approved' || to === 'Rejected') {
    confirmationPrompt = `Confirm recording the official portal outcome as "${to}".`;
  } else if (to === 'Withdrawn' || to === 'Closed') {
    confirmationPrompt = `Confirm changing this application status to "${to}".`;
  } else if (to === 'Correction Required') {
    confirmationPrompt =
      'Confirm marking this application as "Correction Required" and note what the portal requested.';
  }

  return {
    allowed: true,
    requiresConfirmation,
    confirmationPrompt,
    normalizedFrom: from,
    normalizedTo: to,
  };
}

export function eventTypeForStatusTransition(
  toStatus: Phase8ApplicationStatus
): ApplicationEventType {
  switch (toStatus) {
    case 'Preparing':
      return 'Preparation Started';
    case 'Ready to Apply':
      return 'Marked Ready';
    case 'Submitted':
      return 'Submission Confirmed';
    case 'Correction Required':
      return 'Correction Requested';
    case 'Approved':
    case 'Rejected':
    case 'Withdrawn':
    case 'Closed':
      return 'Final Outcome Recorded';
    default:
      return 'Status Changed';
  }
}

export function findDuplicateActiveApplication(
  applications: ApplicationRecord[],
  scholarshipId: string,
  excludeAppId?: string
): ApplicationRecord | null {
  return (
    applications.find(
      (a) =>
        a.scholarshipId === scholarshipId &&
        a.id !== excludeAppId &&
        isActiveApplicationStatus(a.status)
    ) ?? null
  );
}

// ===========================================================================
// Deadline Intelligence (IST Asia/Kolkata calendar normalization)
// ===========================================================================

export type DeadlineIntelligenceState =
  | 'Verified Upcoming'
  | 'Due Today'
  | 'Approaching'
  | 'Expired'
  | 'Closed'
  | 'Not Verified'
  | 'Unavailable';

export interface DeadlineIntelligence {
  state: DeadlineIntelligenceState;
  rawDeadline: string;
  isoDate: string | null;
  daysRemaining: number | null;
  isVerifiedDate: boolean;
  isApproaching: boolean;
  isUrgent: boolean;
  isExpired: boolean;
  displayLabel: string;
  detail: string;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toIstDayNumber(date: Date): number {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return Math.floor(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) / 86400000);
}

function parseIsoDateOnlyToDayNumber(raw?: string): { isoDate: string; dayNumber: number } | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utcDay = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  return {
    isoDate: `${match[1]}-${match[2]}-${match[3]}`,
    dayNumber: utcDay,
  };
}

export function evaluateDeadlineIntelligence(
  scholarship: Scholarship | null | undefined,
  customDeadline?: string,
  referenceDate: Date = new Date()
): DeadlineIntelligence {
  if (!scholarship) {
    const customParsed = parseIsoDateOnlyToDayNumber(customDeadline);
    return {
      state: 'Unavailable',
      rawDeadline: customDeadline || 'Unavailable',
      isoDate: customParsed?.isoDate ?? null,
      daysRemaining: null,
      isVerifiedDate: false,
      isApproaching: false,
      isUrgent: false,
      isExpired: false,
      displayLabel: 'Deadline unavailable (scheme record missing)',
      detail:
        'Linked scholarship record is unavailable in the database. Verify current cycle dates on the official portal.',
    };
  }

  const effectiveCycle = resolveApplicationCycleStatus(scholarship, referenceDate);
  const isSourceVerified = isScholarshipSourceVerified(scholarship.verificationStatus);
  const rawSchDeadline = (scholarship.applicationDeadline ?? '').trim();
  const parsedScholarshipDate = parseIsoDateOnlyToDayNumber(rawSchDeadline);

  if (effectiveCycle === 'Closed' || scholarship.applicationStatus === 'Closed') {
    return {
      state: 'Closed',
      rawDeadline: rawSchDeadline || 'Closed',
      isoDate: parsedScholarshipDate?.isoDate ?? null,
      daysRemaining: null,
      isVerifiedDate: isSourceVerified && Boolean(parsedScholarshipDate),
      isApproaching: false,
      isUrgent: false,
      isExpired: true,
      displayLabel: 'Portal Closed',
      detail: 'The scholarship cycle is currently marked Closed in the verified catalogue.',
    };
  }

  if (parsedScholarshipDate) {
    const todayDay = toIstDayNumber(referenceDate);
    const daysRemaining = parsedScholarshipDate.dayNumber - todayDay;

    if (daysRemaining < 0 || effectiveCycle === 'Expired') {
      const daysAgo = Math.abs(daysRemaining);
      return {
        state: 'Expired',
        rawDeadline: rawSchDeadline,
        isoDate: parsedScholarshipDate.isoDate,
        daysRemaining,
        isVerifiedDate: isSourceVerified,
        isApproaching: false,
        isUrgent: false,
        isExpired: true,
        displayLabel: `Expired (${parsedScholarshipDate.isoDate})`,
        detail: `Recorded deadline passed ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago (${parsedScholarshipDate.isoDate} IST). Do not assume the scheme has reopened unless officially announced.`,
      };
    }

    if (!isSourceVerified) {
      return {
        state: 'Not Verified',
        rawDeadline: rawSchDeadline,
        isoDate: parsedScholarshipDate.isoDate,
        daysRemaining,
        isVerifiedDate: false,
        isApproaching: daysRemaining <= 7,
        isUrgent: daysRemaining <= 3,
        isExpired: false,
        displayLabel: `${parsedScholarshipDate.isoDate} (Deadline not verified)`,
        detail: `Scholarship verification status is "${scholarship.verificationStatus}". Confirm deadline ${parsedScholarshipDate.isoDate} directly on the official portal.`,
      };
    }

    if (daysRemaining === 0) {
      return {
        state: 'Due Today',
        rawDeadline: rawSchDeadline,
        isoDate: parsedScholarshipDate.isoDate,
        daysRemaining: 0,
        isVerifiedDate: true,
        isApproaching: true,
        isUrgent: true,
        isExpired: false,
        displayLabel: `Due Today (${parsedScholarshipDate.isoDate})`,
        detail: `Verified deadline is today (${parsedScholarshipDate.isoDate} IST). Complete portal submission immediately if eligible and documents are ready.`,
      };
    }

    if (daysRemaining <= 7) {
      return {
        state: 'Approaching',
        rawDeadline: rawSchDeadline,
        isoDate: parsedScholarshipDate.isoDate,
        daysRemaining,
        isVerifiedDate: true,
        isApproaching: true,
        isUrgent: daysRemaining <= 3,
        isExpired: false,
        displayLabel: `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left (${parsedScholarshipDate.isoDate})`,
        detail: `Verified deadline approaching in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} (${parsedScholarshipDate.isoDate} IST).`,
      };
    }

    return {
      state: 'Verified Upcoming',
      rawDeadline: rawSchDeadline,
      isoDate: parsedScholarshipDate.isoDate,
      daysRemaining,
      isVerifiedDate: true,
      isApproaching: false,
      isUrgent: false,
      isExpired: false,
      displayLabel: `${daysRemaining} days left (${parsedScholarshipDate.isoDate})`,
      detail: `Verified deadline on ${parsedScholarshipDate.isoDate} IST (${daysRemaining} days remaining).`,
    };
  }

  // Fallback check if student entered a personal target date while scholarship date isn't published
  const parsedCustom = parseIsoDateOnlyToDayNumber(customDeadline);
  if (parsedCustom) {
    const todayDay = toIstDayNumber(referenceDate);
    const daysRemaining = parsedCustom.dayNumber - todayDay;
    return {
      state: 'Not Verified',
      rawDeadline: customDeadline || '',
      isoDate: parsedCustom.isoDate,
      daysRemaining,
      isVerifiedDate: false,
      isApproaching: daysRemaining >= 0 && daysRemaining <= 7,
      isUrgent: daysRemaining >= 0 && daysRemaining <= 3,
      isExpired: daysRemaining < 0,
      displayLabel: `Target ${parsedCustom.isoDate} (Official deadline not verified)`,
      detail:
        'Official scholarship cycle deadline is not published as a verified date yet. Showing your personal target date — confirm active dates on the official portal.',
    };
  }

  if (
    !rawSchDeadline ||
    rawSchDeadline.toLowerCase().includes('check official portal') ||
    rawSchDeadline.toLowerCase().includes('seasonal')
  ) {
    return {
      state: 'Not Verified',
      rawDeadline: rawSchDeadline || 'Deadline unavailable',
      isoDate: null,
      daysRemaining: null,
      isVerifiedDate: false,
      isApproaching: false,
      isUrgent: false,
      isExpired: false,
      displayLabel: rawSchDeadline ? 'Deadline not verified' : 'Deadline unavailable',
      detail:
        'Official portal cycle dates vary seasonally and are not published as a fixed verified date. Verify the active window on the official portal.',
    };
  }

  return {
    state: 'Unavailable',
    rawDeadline: rawSchDeadline,
    isoDate: null,
    daysRemaining: null,
    isVerifiedDate: false,
    isApproaching: false,
    isUrgent: false,
    isExpired: false,
    displayLabel: 'Deadline unavailable',
    detail: `Recorded deadline value "${rawSchDeadline}" could not be verified as a calendar date.`,
  };
}

// ===========================================================================
// Scholarship-Specific Document Checklist + TrustGuard Integration
// ===========================================================================

export type ApplicationChecklistStatus =
  | 'Verified Ready'
  | 'TrustGuard Warning'
  | 'Uploaded — Needs Review'
  | 'Processing'
  | 'Failed — Re-upload'
  | 'Missing';

export interface ApplicationChecklistEvaluatedItem {
  requirementName: string;
  existsInUploads: boolean;
  linkedDocument: DocumentRecord | null;
  linkedAnalysis: DocumentAnalysis | null;
  extractionStatus: DocumentProcessingStatus | 'Not Uploaded';
  trustGuardFindings: TrustGuardFinding[];
  manualReviewRequired: boolean;
  checklistStatus: ApplicationChecklistStatus;
  canMarkStudentComplete: boolean;
  studentMarkedComplete: boolean;
  studentChecklistNotes?: string;
  recommendedAction: string;
  recommendedRoute: string;
  notes: string[];
}

export interface ApplicationChecklistEvaluation {
  scholarshipId: string;
  hasPublishedChecklist: boolean;
  disclosureNotice?: string;
  totalRequired: number;
  readyCount: number;
  warningCount: number;
  needsReviewCount: number;
  missingCount: number;
  completionPercent: number;
  items: ApplicationChecklistEvaluatedItem[];
}

function doesTrustGuardFindingAffectRequirement(
  finding: TrustGuardFinding,
  requirementName: string,
  linkedDocument: DocumentRecord | null,
  scholarshipId: string
): boolean {
  if (linkedDocument && finding.affectedDocuments.some((d) => d.documentId === linkedDocument.id)) {
    return true;
  }
  const reqLower = requirementName.toLowerCase();
  if (
    finding.category === 'Scholarship Requirement Gap' &&
    (finding.relatedScholarshipIds ?? []).includes(scholarshipId) &&
    finding.title.toLowerCase().includes(reqLower.split(' ')[0])
  ) {
    return true;
  }
  return false;
}

export function buildApplicationDocumentChecklist(params: {
  applicationId: string;
  scholarship: Scholarship | null | undefined;
  profile: StudentProfile | null;
  documents: DocumentRecord[];
  documentAnalyses: DocumentAnalysis[];
  trustGuardAssessment?: Pick<TrustGuardDocumentAssessment, 'findings'> | null;
  savedChecklistItems?: ApplicationChecklistItemRecord[];
}): ApplicationChecklistEvaluation {
  const {
    applicationId,
    scholarship,
    profile,
    documents,
    documentAnalyses,
    trustGuardAssessment,
    savedChecklistItems = [],
  } = params;

  if (!scholarship) {
    return {
      scholarshipId: '',
      hasPublishedChecklist: false,
      disclosureNotice:
        'Scholarship record has been removed or is unavailable. Cannot generate scheme-specific document requirements.',
      totalRequired: 0,
      readyCount: 0,
      warningCount: 0,
      needsReviewCount: 0,
      missingCount: 0,
      completionPercent: 0,
      items: [],
    };
  }

  const docReport = compareDocumentsAgainstScholarship(
    scholarship,
    documents,
    documentAnalyses,
    profile
  );

  if (!docReport.hasPublishedRequirements) {
    return {
      scholarshipId: scholarship.id,
      hasPublishedChecklist: false,
      disclosureNotice: docReport.limitationNotice,
      totalRequired: 0,
      readyCount: 0,
      warningCount: 0,
      needsReviewCount: 0,
      missingCount: 0,
      completionPercent: 0,
      items: [],
    };
  }

  const savedByReq = new Map<string, ApplicationChecklistItemRecord>();
  savedChecklistItems
    .filter((i) => i.applicationId === applicationId)
    .forEach((i) => savedByReq.set(i.requirementName.toLowerCase(), i));

  const tgFindings = trustGuardAssessment?.findings ?? [];

  let readyCount = 0;
  let warningCount = 0;
  let needsReviewCount = 0;
  let missingCount = 0;

  const items: ApplicationChecklistEvaluatedItem[] = docReport.items.map((comp) => {
    const linkedDocument = comp.matchedDocument ?? null;
    const linkedAnalysis = comp.matchedAnalysis ?? null;
    const existsInUploads = Boolean(linkedDocument);
    const saved = savedByReq.get(comp.requiredDocument.toLowerCase());

    const matchingFindings = tgFindings.filter((f) =>
      doesTrustGuardFindingAffectRequirement(f, comp.requiredDocument, linkedDocument, scholarship.id)
    );
    const hasCriticalOrHighTg = matchingFindings.some(
      (f) => f.severity === 'Critical' || f.severity === 'High'
    );
    const hasAnyTg = matchingFindings.length > 0;

    let extractionStatus: DocumentProcessingStatus | 'Not Uploaded' = 'Not Uploaded';
    if (linkedDocument) {
      extractionStatus = linkedDocument.processingStatus ?? 'Completed';
    }

    let checklistStatus: ApplicationChecklistStatus;
    let manualReviewRequired = false;
    let canMarkStudentComplete = false;
    let recommendedAction = '';
    let recommendedRoute = '/documents';

    if (!existsInUploads || comp.status === 'Missing') {
      checklistStatus = 'Missing';
      missingCount += 1;
      manualReviewRequired = false;
      canMarkStudentComplete = false; // Strict rule: never allow missing documents to be marked complete
      recommendedAction = `Upload and analyze "${comp.requiredDocument}" in Document Intelligence.`;
      recommendedRoute = '/documents';
    } else if (comp.status === 'Failed') {
      checklistStatus = 'Failed — Re-upload';
      needsReviewCount += 1;
      manualReviewRequired = true;
      canMarkStudentComplete = false;
      recommendedAction = `Replace unreadable/failed file "${linkedDocument!.fileName}" or retry extraction.`;
      recommendedRoute = '/documents';
    } else if (comp.status === 'Processing') {
      checklistStatus = 'Processing';
      needsReviewCount += 1;
      manualReviewRequired = true;
      canMarkStudentComplete = false;
      recommendedAction = `Wait for extraction to finish for "${linkedDocument!.fileName}" in Document Intelligence.`;
      recommendedRoute = '/documents';
    } else if (hasCriticalOrHighTg) {
      checklistStatus = 'TrustGuard Warning';
      warningCount += 1;
      manualReviewRequired = true;
      canMarkStudentComplete = false;
      recommendedAction =
        matchingFindings[0]?.recommendedAction ||
        `Resolve TrustGuard mismatch on "${linkedDocument!.fileName}" before applying.`;
      recommendedRoute = '/trustguard';
    } else if (comp.status === 'Needs Review' || hasAnyTg) {
      checklistStatus = hasAnyTg ? 'TrustGuard Warning' : 'Uploaded — Needs Review';
      if (hasAnyTg) warningCount += 1;
      else needsReviewCount += 1;
      manualReviewRequired = true;
      canMarkStudentComplete = true;
      recommendedAction =
        matchingFindings[0]?.recommendedAction ||
        comp.notes[0] ||
        `Review extracted fields for "${linkedDocument!.fileName}" in Document Intelligence.`;
      recommendedRoute = hasAnyTg ? '/trustguard' : '/documents';
    } else {
      checklistStatus = 'Verified Ready';
      readyCount += 1;
      manualReviewRequired = false;
      canMarkStudentComplete = true;
      recommendedAction = 'Document extracted cleanly and matches profile/scheme checks. Keep PDF ready for portal upload.';
      recommendedRoute = '/documents';
    }

    return {
      requirementName: comp.requiredDocument,
      existsInUploads,
      linkedDocument,
      linkedAnalysis,
      extractionStatus,
      trustGuardFindings: matchingFindings,
      manualReviewRequired,
      checklistStatus,
      canMarkStudentComplete,
      studentMarkedComplete: canMarkStudentComplete ? Boolean(saved?.isCompleted) : false,
      studentChecklistNotes: saved?.notes,
      recommendedAction,
      recommendedRoute,
      notes: comp.notes,
    };
  });

  const totalRequired = items.length;
  const completionPercent =
    totalRequired > 0 ? Math.round((readyCount / totalRequired) * 100) : 0;

  return {
    scholarshipId: scholarship.id,
    hasPublishedChecklist: true,
    disclosureNotice: docReport.limitationNotice,
    totalRequired,
    readyCount,
    warningCount,
    needsReviewCount,
    missingCount,
    completionPercent,
    items,
  };
}

// ===========================================================================
// Smart Tracked Application Summary (Eligibility + Checklist + TrustGuard + Deadline)
// ===========================================================================

export type ApplicationPreparationLabel =
  | 'Ready for Submission'
  | 'In Preparation'
  | 'Action Required'
  | 'Blocked — Missing Docs/Info'
  | 'Blocked — Eligibility/Cycle'
  | 'Post-Submission Tracking'
  | 'Completed / Closed';

export interface EvaluatedTrackedApplication {
  application: ApplicationRecord;
  normalizedStatus: Phase8ApplicationStatus;
  scholarship: Scholarship | null;
  scholarshipMissingOrArchived: boolean;
  scholarshipDisclosure?: string;
  isSourceVerified: boolean;
  deadline: DeadlineIntelligence;
  eligibilityStatus: EligibilityOverallStatus | 'Scholarship Unavailable';
  eligibilityScore: number | null;
  missingEligibilityFields: string[];
  failedEligibilityCriteria: string[];
  checklist: ApplicationChecklistEvaluation;
  trustGuardFindingsForApp: TrustGuardFinding[];
  unresolvedCriticalOrHighFindings: number;
  preparationStatus: ApplicationPreparationLabel;
  needsAttention: boolean;
  attentionReasons: string[];
  nextRecommendedAction: string;
  nextRecommendedRoute: string;
  allowedNextStatuses: Phase8ApplicationStatus[];
}

export function evaluateTrackedApplication(params: {
  application: ApplicationRecord;
  scholarship: Scholarship | null | undefined;
  profile: StudentProfile | null;
  documents: DocumentRecord[];
  documentAnalyses: DocumentAnalysis[];
  trustGuardAssessment?: Pick<TrustGuardDocumentAssessment, 'findings'> | null;
  savedChecklistItems?: ApplicationChecklistItemRecord[];
  referenceDate?: Date;
}): EvaluatedTrackedApplication {
  const {
    application,
    scholarship,
    profile,
    documents,
    documentAnalyses,
    savedChecklistItems = [],
    referenceDate = new Date(),
  } = params;

  const normalizedStatus = normalizeApplicationStatus(application.status);
  const scholarshipMissing = !scholarship;
  const scholarshipArchived = scholarship?.verificationStatus === 'Archived';
  const scholarshipMissingOrArchived = scholarshipMissing || scholarshipArchived;
  const isSourceVerified = scholarship
    ? isScholarshipSourceVerified(scholarship.verificationStatus)
    : false;

  let scholarshipDisclosure: string | undefined;
  if (scholarshipMissing) {
    scholarshipDisclosure =
      'This scholarship record was removed or is unavailable in the database. Existing application history is preserved; verify scheme status on official portals.';
  } else if (scholarshipArchived) {
    scholarshipDisclosure =
      'This scholarship record has been archived by an administrator and is no longer active for new applications.';
  } else if (!isSourceVerified) {
    scholarshipDisclosure = `Official verification status is "${scholarship.verificationStatus}". Verify current rules and portal URL directly before submitting.`;
  }

  const deadline = evaluateDeadlineIntelligence(scholarship, application.deadline, referenceDate);

  const tgEvaluation =
    params.trustGuardAssessment ??
    evaluateTrustGuardVerification({
      userId: application.userId,
      profile,
      documents,
      documentAnalyses,
      scholarships: scholarship ? [scholarship] : [],
      savedScholarships: [],
      applications: [application],
      referenceDate,
    });

  const checklist = buildApplicationDocumentChecklist({
    applicationId: application.id,
    scholarship,
    profile,
    documents,
    documentAnalyses,
    trustGuardAssessment: tgEvaluation,
    savedChecklistItems,
  });

  const eligibility = scholarship
    ? evaluateDeterministicEligibility(profile, scholarship, referenceDate)
    : null;
  const eligibilityStatus: EvaluatedTrackedApplication['eligibilityStatus'] = eligibility
    ? eligibility.overallStatus
    : 'Scholarship Unavailable';
  const eligibilityScore = eligibility ? eligibility.compatibilityScore : null;
  const missingEligibilityFields = eligibility
    ? eligibility.missingProfileFields.map((f) => f.label)
    : [];
  const failedEligibilityCriteria = eligibility ? eligibility.failedCriteria : [];

  const linkedDocIds = new Set(
    checklist.items.map((i) => i.linkedDocument?.id).filter((id): id is string => Boolean(id))
  );

  const trustGuardFindingsForApp = (tgEvaluation.findings ?? []).filter(
    (f) =>
      (f.relatedScholarshipIds ?? []).includes(application.scholarshipId) ||
      f.affectedDocuments.some((ad) => linkedDocIds.has(ad.documentId))
  );
  const unresolvedCriticalOrHighFindings = trustGuardFindingsForApp.filter(
    (f) => f.severity === 'Critical' || f.severity === 'High'
  ).length;

  const attentionReasons: string[] = [];
  if (scholarshipMissingOrArchived) {
    attentionReasons.push(
      scholarshipMissing
        ? 'Scholarship record removed or unavailable'
        : 'Scholarship record archived'
    );
  }
  if (normalizedStatus === 'Correction Required') {
    attentionReasons.push('Portal correction required by student');
  }
  if (
    deadline.isApproaching &&
    isActiveApplicationStatus(normalizedStatus) &&
    normalizedStatus !== 'Submitted' &&
    normalizedStatus !== 'Under Review'
  ) {
    attentionReasons.push(
      deadline.daysRemaining === 0
        ? 'Deadline is today'
        : `Deadline in ${deadline.daysRemaining} day(s)`
    );
  }
  if (
    deadline.isExpired &&
    (normalizedStatus === 'Interested' ||
      normalizedStatus === 'Preparing' ||
      normalizedStatus === 'Documents Pending' ||
      normalizedStatus === 'Ready to Apply')
  ) {
    attentionReasons.push('Scholarship deadline expired while still preparing');
  }
  if (checklist.missingCount > 0 && isActiveApplicationStatus(normalizedStatus)) {
    attentionReasons.push(`${checklist.missingCount} required document(s) missing`);
  }
  if (unresolvedCriticalOrHighFindings > 0) {
    attentionReasons.push(
      `${unresolvedCriticalOrHighFindings} Critical/High TrustGuard consistency risk(s)`
    );
  }
  if (eligibilityStatus === 'Insufficient Information') {
    attentionReasons.push('Missing profile information needed for eligibility');
  }

  let preparationStatus: ApplicationPreparationLabel;
  let nextRecommendedAction = '';
  let nextRecommendedRoute = `/applications/${application.id}`;

  if (
    normalizedStatus === 'Approved' ||
    normalizedStatus === 'Rejected' ||
    normalizedStatus === 'Withdrawn' ||
    normalizedStatus === 'Closed'
  ) {
    preparationStatus = 'Completed / Closed';
    nextRecommendedAction = `Application is ${normalizedStatus}. History and records preserved.`;
  } else if (normalizedStatus === 'Correction Required') {
    preparationStatus = 'Action Required';
    nextRecommendedAction =
      application.correctionNotes?.trim() ||
      'Review requested corrections, update documents or profile details, and resubmit on the official portal.';
  } else if (normalizedStatus === 'Submitted' || normalizedStatus === 'Under Review') {
    preparationStatus = 'Post-Submission Tracking';
    nextRecommendedAction = application.portalReferenceId
      ? `Track portal reference ${application.portalReferenceId} for review updates or correction notices.`
      : 'Add your official portal acknowledgement/reference ID and monitor for Under Review or Correction Required updates.';
  } else if (
    scholarshipMissingOrArchived ||
    deadline.isExpired ||
    eligibilityStatus === 'Not Eligible'
  ) {
    preparationStatus = 'Blocked — Eligibility/Cycle';
    if (scholarshipMissingOrArchived) {
      nextRecommendedAction =
        'Scholarship is archived or unavailable. Close or withdraw this application after checking the official portal.';
    } else if (deadline.isExpired) {
      nextRecommendedAction =
        'Recorded deadline has expired. Verify on the official portal whether a new cycle opened, or close/withdraw.';
    } else {
      nextRecommendedAction = `Eligibility check shows Not Eligible (${failedEligibilityCriteria.join(', ')}). Review other matching schemes.`;
      nextRecommendedRoute = '/eligibility';
    }
  } else if (unresolvedCriticalOrHighFindings > 0) {
    preparationStatus = 'Action Required';
    nextRecommendedAction =
      'Resolve Critical/High TrustGuard document consistency findings before applying.';
    nextRecommendedRoute = '/trustguard';
  } else if (eligibilityStatus === 'Insufficient Information') {
    preparationStatus = 'Blocked — Missing Docs/Info';
    nextRecommendedAction = `Complete missing profile field(s): ${missingEligibilityFields.join(', ')}.`;
    nextRecommendedRoute = '/profile';
  } else if (checklist.missingCount > 0) {
    preparationStatus = 'Blocked — Missing Docs/Info';
    const missingNames = checklist.items
      .filter((i) => i.checklistStatus === 'Missing')
      .map((i) => i.requirementName);
    nextRecommendedAction = `Upload ${missingNames.length} missing required document(s): ${missingNames.slice(0, 2).join(', ')}.`;
    nextRecommendedRoute = '/documents';
  } else if (checklist.needsReviewCount > 0 || checklist.warningCount > 0) {
    preparationStatus = 'In Preparation';
    nextRecommendedAction =
      'Review flagged documents or marksheet confirmation in Document Intelligence before marking Ready to Apply.';
    nextRecommendedRoute = '/documents';
  } else if (normalizedStatus === 'Ready to Apply') {
    preparationStatus = 'Ready for Submission';
    nextRecommendedAction = isSourceVerified
      ? 'Proceed to the official portal link to submit your application, then confirm submission and record your reference ID here.'
      : 'Confirm current cycle guidelines on the official portal, submit externally, then record your submission here.';
  } else {
    preparationStatus = 'In Preparation';
    nextRecommendedAction = !isSourceVerified || deadline.state === 'Not Verified'
      ? 'Verify live dates on official portal and advance checklist to Ready to Apply.'
      : 'Complete remaining checklist review and mark application as Ready to Apply.';
  }

  return {
    application,
    normalizedStatus,
    scholarship: scholarship ?? null,
    scholarshipMissingOrArchived,
    scholarshipDisclosure,
    isSourceVerified,
    deadline,
    eligibilityStatus,
    eligibilityScore,
    missingEligibilityFields,
    failedEligibilityCriteria,
    checklist,
    trustGuardFindingsForApp,
    unresolvedCriticalOrHighFindings,
    preparationStatus,
    needsAttention: attentionReasons.length > 0,
    attentionReasons,
    nextRecommendedAction,
    nextRecommendedRoute,
    allowedNextStatuses: getAllowedNextStatuses(normalizedStatus),
  };
}

// ===========================================================================
// Dashboard Summary Counts & Notification Derivation
// ===========================================================================

export interface TrackerOverviewCounts {
  total: number;
  beingPrepared: number;
  submitted: number;
  underReview: number;
  approved: number;
  rejected: number;
  requiringAction: number;
}

export function computeTrackerOverviewCounts(
  evaluated: EvaluatedTrackedApplication[]
): TrackerOverviewCounts {
  let beingPrepared = 0;
  let submitted = 0;
  let underReview = 0;
  let approved = 0;
  let rejected = 0;
  let requiringAction = 0;

  for (const item of evaluated) {
    const st = item.normalizedStatus;
    if (
      st === 'Interested' ||
      st === 'Preparing' ||
      st === 'Documents Pending' ||
      st === 'Ready to Apply'
    ) {
      beingPrepared += 1;
    } else if (st === 'Submitted') {
      submitted += 1;
    } else if (st === 'Under Review') {
      underReview += 1;
    } else if (st === 'Approved') {
      approved += 1;
    } else if (st === 'Rejected') {
      rejected += 1;
    }

    if (item.needsAttention) {
      requiringAction += 1;
    }
  }

  return {
    total: evaluated.length,
    beingPrepared,
    submitted,
    underReview,
    approved,
    rejected,
    requiringAction,
  };
}

export function deriveApplicationNotifications(params: {
  userId: string;
  evaluatedApps: EvaluatedTrackedApplication[];
  existingNotifications: NotificationRecord[];
  preferences?: NotificationPreferenceRecord | null;
  nowIso?: string;
}): NotificationRecord[] {
  const {
    userId,
    evaluatedApps,
    existingNotifications,
    preferences,
    nowIso = new Date().toISOString(),
  } = params;

  const deadlineEnabled = preferences?.deadlineRemindersEnabled ?? true;
  const docsEnabled = preferences?.missingDocsAlertsEnabled ?? true;
  const statusEnabled = preferences?.statusChangeAlertsEnabled ?? true;

  const existingKeys = new Set(
    existingNotifications.map((n) => n.dedupeKey).filter((k): k is string => Boolean(k))
  );
  const generated: NotificationRecord[] = [];

  const pushIfNew = (
    dedupeKey: string,
    payload: Omit<
      NotificationRecord,
      'id' | 'userId' | 'isRead' | 'createdAt' | 'dedupeKey' | 'deliveryChannel' | 'deliveryStatus'
    >
  ) => {
    if (existingKeys.has(dedupeKey)) return;
    existingKeys.add(dedupeKey);
    generated.push({
      id: `notif-${dedupeKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}-${Date.now().toString(36)}`,
      userId,
      ...payload,
      dedupeKey,
      deliveryChannel: 'in-app',
      deliveryStatus: 'Delivered In-App',
      isRead: false,
      createdAt: nowIso,
    });
  };

  for (const item of evaluatedApps) {
    const app = item.application;
    const st = item.normalizedStatus;
    const titleShort = app.scholarshipTitle.slice(0, 70);

    // 1. Approaching deadline
    if (
      deadlineEnabled &&
      item.deadline.isApproaching &&
      item.deadline.isoDate &&
      (st === 'Interested' ||
        st === 'Preparing' ||
        st === 'Documents Pending' ||
        st === 'Ready to Apply' ||
        st === 'Correction Required')
    ) {
      pushIfNew(`deadline-${app.id}-${item.deadline.isoDate}`, {
        title: `Deadline approaching: ${titleShort}`,
        message: item.deadline.detail,
        category: 'Deadline',
        applicationId: app.id,
        scholarshipId: app.scholarshipId,
        actionRoute: `/applications/${app.id}`,
      });
    }

    // 2. Expired deadline while still preparing
    if (
      deadlineEnabled &&
      item.deadline.isExpired &&
      (st === 'Interested' ||
        st === 'Preparing' ||
        st === 'Documents Pending' ||
        st === 'Ready to Apply')
    ) {
      pushIfNew(`expired-${app.id}-${item.deadline.isoDate || 'closed'}`, {
        title: `Deadline passed: ${titleShort}`,
        message: item.deadline.detail,
        category: 'Deadline',
        applicationId: app.id,
        scholarshipId: app.scholarshipId,
        actionRoute: `/applications/${app.id}`,
      });
    }

    // 3. Missing required documents
    if (
      docsEnabled &&
      item.checklist.missingCount > 0 &&
      (st === 'Preparing' || st === 'Documents Pending' || st === 'Ready to Apply')
    ) {
      const missingList = item.checklist.items
        .filter((i) => i.checklistStatus === 'Missing')
        .map((i) => i.requirementName)
        .slice(0, 3)
        .join(', ');
      pushIfNew(`missing-docs-${app.id}-${item.checklist.missingCount}`, {
        title: `${item.checklist.missingCount} missing document(s): ${titleShort}`,
        message: `Upload required document(s): ${missingList}.`,
        category: 'Document',
        applicationId: app.id,
        scholarshipId: app.scholarshipId,
        actionRoute: `/applications/${app.id}`,
      });
    }

    // 4. Correction Required alert
    if (statusEnabled && st === 'Correction Required') {
      pushIfNew(`correction-${app.id}-${app.lastStatusChangedAt || app.updatedAt}`, {
        title: `Correction required: ${titleShort}`,
        message:
          app.correctionNotes?.trim() ||
          'Application is marked Correction Required. Inspect TrustGuard/documents and update on the official portal.',
        category: 'Application',
        applicationId: app.id,
        scholarshipId: app.scholarshipId,
        actionRoute: `/applications/${app.id}`,
      });
    }

    // 5. TrustGuard Critical/High finding alert
    if (docsEnabled && item.unresolvedCriticalOrHighFindings > 0 && isActiveApplicationStatus(st)) {
      pushIfNew(`tg-${app.id}-${item.unresolvedCriticalOrHighFindings}`, {
        title: `TrustGuard warning for ${titleShort}`,
        message: `${item.unresolvedCriticalOrHighFindings} Critical/High consistency issue(s) affect required documents for this application.`,
        category: 'TrustGuard',
        applicationId: app.id,
        scholarshipId: app.scholarshipId,
        actionRoute: `/applications/${app.id}`,
      });
    }
  }

  return generated;
}

export function getDeadlineTimestampForSort(deadline: DeadlineIntelligence): number {
  if (deadline.isoDate) {
    const ts = parseScholarshipDeadlineTimestamp(deadline.isoDate);
    if (ts !== null) return ts;
  }
  return Number.MAX_SAFE_INTEGER;
}
