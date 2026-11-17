import {
  isScholarshipSourceVerified,
  parseScholarshipDeadlineTimestamp,
  resolveApplicationCycleStatus,
} from './eligibilityEngine.ts';
import type {
  AdminDashboardMetrics,
  AdminStudentOversightItem,
  ApplicationRecord,
  AppRole,
  DataQualityIssueRecord,
  DocumentAnalysis,
  DocumentProcessingStatus,
  DocumentRecord,
  EligibilityRuleOperator,
  Scholarship,
  ScholarshipEligibilityRule,
  StudentProfile,
  TrustGuardDocumentAssessment,
  TrustGuardFinding,
  TrustGuardReport,
  TrustGuardSeverityCounts,
  VerificationStatus,
} from '../types/database.ts';

export const PHASE9_VERIFICATION_STATUSES: VerificationStatus[] = [
  'Unverified',
  'Pending Review',
  'Verified',
  'Needs Correction',
  'Expired',
  'Archived',
];

export const LEGACY_TO_PHASE9_VERIFICATION: Record<string, VerificationStatus> = {
  Verified: 'Verified',
  'Verified Official Source': 'Verified',
  'Pending verification': 'Pending Review',
  'Pending Review': 'Pending Review',
  'Needs verification': 'Needs Correction',
  'Needs Correction': 'Needs Correction',
  Unverified: 'Unverified',
  Expired: 'Expired',
  Archived: 'Archived',
};

export function normalizeVerificationStatus(status?: VerificationStatus | string): VerificationStatus {
  if (!status) return 'Unverified';
  return LEGACY_TO_PHASE9_VERIFICATION[status] ?? 'Unverified';
}

export function isVerifiedScholarshipStatus(status?: VerificationStatus): boolean {
  return Boolean(status && isScholarshipSourceVerified(status));
}

export function normalizeAppRole(role?: string | null): 'student' | 'admin' | 'super_admin' {
  if (role === 'super_admin') return 'super_admin';
  if (role === 'admin' || role === 'reviewer') return 'admin';
  return 'student';
}

export function isPrivilegedRole(role?: AppRole | string | null, status?: string): boolean {
  if (status === 'disabled') return false;
  return role === 'admin' || role === 'super_admin';
}

export function isSuperAdminRole(role?: AppRole | string | null, status?: string): boolean {
  if (status === 'disabled') return false;
  return role === 'super_admin';
}

export interface VerificationEvidenceInput {
  newStatus: VerificationStatus;
  officialSourceUrl?: string;
  sourceName?: string;
  sourceEvidence?: string;
  verificationNotes?: string;
  humanConfirmed?: boolean;
}

export function validateVerificationEvidence(
  input: VerificationEvidenceInput
): { valid: true } | { valid: false; reason: string } {
  const normalizedNext = normalizeVerificationStatus(input.newStatus);

  if (normalizedNext === 'Verified') {
    if (!input.humanConfirmed) {
      return {
        valid: false,
        reason:
          'Human administrator confirmation is required before marking any scholarship as Verified. A URL or AI summary alone never auto-verifies a scholarship.',
      };
    }
    const sourceUrl = (input.officialSourceUrl ?? '').trim();
    if (!sourceUrl.startsWith('https://') && !sourceUrl.startsWith('http://')) {
      return {
        valid: false,
        reason: 'Verified scholarships require a valid http(s) official source URL.',
      };
    }
    const evidence = (input.sourceEvidence ?? '').trim();
    if (evidence.length < 10) {
      return {
        valid: false,
        reason:
          'Please record authoritative source evidence (minimum 10 characters citing official portal guidelines or circular) before verifying.',
      };
    }
  }

  if (normalizedNext === 'Needs Correction' && !(input.verificationNotes ?? '').trim()) {
    return {
      valid: false,
      reason: 'Provide verification notes explaining what needs correction.',
    };
  }

  return { valid: true };
}

// ============================================================================
// Eligibility Rule Validation & Conflict Detection
// ============================================================================

export const ALLOWED_RULE_KEYS = [
  'familyAnnualIncomeInr',
  'previousMarksPercent',
  'educationLevel',
  'courseSpecialization',
  'category',
  'state',
  'gender',
  'disabilityStatus',
  'hostelStatus',
  'certificates',
] as const;

export const NUMERIC_RULE_KEYS = new Set(['familyAnnualIncomeInr', 'previousMarksPercent']);
export const LIST_OR_TEXT_RULE_KEYS = new Set([
  'educationLevel',
  'courseSpecialization',
  'category',
  'state',
  'gender',
  'disabilityStatus',
  'hostelStatus',
  'certificates',
]);

export interface RuleDraftInput {
  id?: string;
  ruleKey: string;
  ruleLabel: string;
  operator: EligibilityRuleOperator;
  ruleValue: string;
  isMandatory: boolean;
  isActive?: boolean;
  description?: string;
}

export function validateScholarshipRuleInput(
  rule: RuleDraftInput
): { valid: true } | { valid: false; reason: string } {
  const key = rule.ruleKey.trim();
  const label = rule.ruleLabel.trim();
  const value = rule.ruleValue.trim();

  if (!key || key.length > 80) {
    return { valid: false, reason: 'Rule field key must be between 1 and 80 characters.' };
  }
  if (!ALLOWED_RULE_KEYS.includes(key as (typeof ALLOWED_RULE_KEYS)[number])) {
    return {
      valid: false,
      reason: `Unsupported ruleKey "${key}". Allowed keys: ${ALLOWED_RULE_KEYS.join(', ')}.`,
    };
  }
  if (!label || label.length < 2 || label.length > 200) {
    return { valid: false, reason: 'Rule label must be between 2 and 200 characters.' };
  }
  if (!value || value.length > 300) {
    return { valid: false, reason: 'Rule value must be non-empty and at most 300 characters.' };
  }

  if (NUMERIC_RULE_KEYS.has(key)) {
    if (rule.operator !== 'lte' && rule.operator !== 'gte' && rule.operator !== 'eq') {
      return {
        valid: false,
        reason: `Numeric field "${key}" only supports lte, gte, or eq operators.`,
      };
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return { valid: false, reason: `Rule "${label}" requires a non-negative numeric value.` };
    }
    if (key === 'previousMarksPercent' && num > 100) {
      return { valid: false, reason: 'Marks percentage threshold cannot exceed 100%.' };
    }
  } else if (LIST_OR_TEXT_RULE_KEYS.has(key)) {
    if (rule.operator === 'lte' || rule.operator === 'gte') {
      return {
        valid: false,
        reason: `Categorical/text field "${key}" does not support numeric operators (${rule.operator}). Use in, eq, neq, or contains.`,
      };
    }
    if (rule.operator === 'in') {
      const items = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length === 0) {
        return { valid: false, reason: 'Operator "in" requires at least one comma-separated value.' };
      }
    }
  }

  return { valid: true };
}

export function detectRuleContradictions(rules: RuleDraftInput[]): string[] {
  const activeRules = rules.filter((r) => r.isActive !== false);
  const errors: string[] = [];

  for (let i = 0; i < activeRules.length; i++) {
    const validation = validateScholarshipRuleInput(activeRules[i]);
    if (!validation.valid) {
      errors.push(`Rule #${i + 1} (${activeRules[i].ruleLabel || activeRules[i].ruleKey}): ${validation.reason}`);
    }
  }

  // Check contradictory numeric bounds on the same ruleKey
  for (const numKey of NUMERIC_RULE_KEYS) {
    const keyRules = activeRules.filter((r) => r.ruleKey === numKey);
    const ltes = keyRules.filter((r) => r.operator === 'lte').map((r) => Number(r.ruleValue));
    const gtes = keyRules.filter((r) => r.operator === 'gte').map((r) => Number(r.ruleValue));
    const eqs = keyRules.filter((r) => r.operator === 'eq').map((r) => Number(r.ruleValue));

    if (ltes.length > 0 && gtes.length > 0) {
      const minGte = Math.max(...gtes);
      const maxLte = Math.min(...ltes);
      if (minGte > maxLte) {
        errors.push(
          `Contradictory numeric range on "${numKey}": minimum required (${minGte}) exceeds maximum allowed (${maxLte}).`
        );
      }
    }
    if (new Set(eqs).size > 1) {
      errors.push(`Conflicting exact-equality rules on "${numKey}": ${eqs.join(' vs ')}.`);
    }
    if (eqs.length > 0 && gtes.some((g) => eqs.some((e) => e < g))) {
      errors.push(`Contradictory eq vs gte bounds on "${numKey}".`);
    }
    if (eqs.length > 0 && ltes.some((l) => eqs.some((e) => e > l))) {
      errors.push(`Contradictory eq vs lte bounds on "${numKey}".`);
    }
  }

  // Check conflicting eq / neq on categorical keys
  const byKey = new Map<string, RuleDraftInput[]>();
  for (const r of activeRules) {
    const list = byKey.get(r.ruleKey) ?? [];
    list.push(r);
    byKey.set(r.ruleKey, list);
  }
  for (const [key, list] of byKey.entries()) {
    const eqVals = new Set(
      list.filter((r) => r.operator === 'eq').map((r) => r.ruleValue.trim().toLowerCase())
    );
    const neqVals = new Set(
      list.filter((r) => r.operator === 'neq').map((r) => r.ruleValue.trim().toLowerCase())
    );
    if (eqVals.size > 1) {
      errors.push(`Conflicting mandatory "eq" values on "${key}".`);
    }
    for (const v of eqVals) {
      if (neqVals.has(v)) {
        errors.push(`Contradictory "eq" and "neq" on "${key}" for value "${v}".`);
      }
    }
  }

  return errors;
}

// ============================================================================
// Duplicate Detection & Data Quality Engine
// ============================================================================

function normalizeTitleTokens(title: string): string[] {
  const stopWords = new Set([
    'scholarship',
    'scheme',
    'for',
    'the',
    'and',
    'of',
    'in',
    'to',
    'students',
    'student',
    'india',
    'programme',
    'program',
    'yojana',
  ]);
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !stopWords.has(t));
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function isValidHttpUrl(url?: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  return /^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(trimmed);
}

function makeIssueId(scholarshipId: string, issueType: string, relatedId?: string): string {
  const raw = `${scholarshipId}__${issueType}${relatedId ? `__${relatedId}` : ''}`;
  return `dq-${raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 110)}`;
}

export function runScholarshipDataQualityScan(params: {
  scholarships: Scholarship[];
  rules: ScholarshipEligibilityRule[];
  existingIssues?: DataQualityIssueRecord[];
  referenceDate?: Date;
}): DataQualityIssueRecord[] {
  const { scholarships, rules, existingIssues = [], referenceDate = new Date() } = params;
  const nowIso = referenceDate.toISOString();
  const existingMap = new Map(existingIssues.map((i) => [i.id, i]));
  const detected: DataQualityIssueRecord[] = [];

  const pushIssue = (draft: Omit<DataQualityIssueRecord, 'id' | 'resolutionStatus' | 'detectedAt' | 'updatedAt'>) => {
    const id = makeIssueId(draft.scholarshipId, draft.issueType, draft.relatedScholarshipId);
    const prev = existingMap.get(id);
    // Preserve Resolved/Ignored status only if admin explicitly marked it Ignored; reopen if still detected and previously Resolved unless ignored
    const resolutionStatus =
      prev && (prev.resolutionStatus === 'Acknowledged' || prev.resolutionStatus === 'Ignored')
        ? prev.resolutionStatus
        : 'Open';

    detected.push({
      ...draft,
      id,
      resolutionStatus,
      detectedAt: prev?.detectedAt ?? nowIso,
      updatedAt: nowIso,
      ...(prev?.resolutionNote ? { resolutionNote: prev.resolutionNote } : {}),
    });
  };

  // 1. Pairwise duplicate candidate detection (never auto-merges or deletes)
  const activeOrReview = scholarships.filter((s) => s.verificationStatus !== 'Archived');
  const seenPairs = new Set<string>();

  for (let i = 0; i < activeOrReview.length; i++) {
    for (let j = i + 1; j < activeOrReview.length; j++) {
      const a = activeOrReview[i];
      const b = activeOrReview[j];
      const pairKey = [a.id, b.id].sort().join('::');
      if (seenPairs.has(pairKey)) continue;

      const normA = a.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      const normB = b.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      const tokensA = normalizeTitleTokens(a.title);
      const tokensB = normalizeTitleTokens(b.title);
      const sim = jaccardSimilarity(tokensA, tokensB);
      const sameUrl =
        Boolean(a.officialUrl) &&
        Boolean(b.officialUrl) &&
        a.officialUrl.trim().toLowerCase() === b.officialUrl.trim().toLowerCase() &&
        a.provider.trim().toLowerCase() === b.provider.trim().toLowerCase() &&
        sim >= 0.45;

      if (normA === normB || sim >= 0.72 || sameUrl) {
        seenPairs.add(pairKey);
        pushIssue({
          scholarshipId: a.id,
          scholarshipTitle: a.title,
          relatedScholarshipId: b.id,
          relatedScholarshipTitle: b.title,
          issueType: 'Duplicate Candidate',
          severity: normA === normB ? 'High' : 'Medium',
          description: `Potential duplicate record with "${b.title}" (${b.id}). Requires manual admin inspection — never auto-deleted or merged.`,
          recommendedCorrection: `Compare "${a.title}" (${a.id}) and "${b.title}" (${b.id}), preserve existing tracker links, and archive only the redundant entry.`,
        });
      }
    }
  }

  // 2. Per-scholarship field, date, rule, and provenance checks
  const oneEightyDaysMs = 180 * 24 * 60 * 60 * 1000;

  for (const s of scholarships) {
    if (s.verificationStatus === 'Archived' || s.isActive === false) continue;

    // Missing official URL
    if (!isValidHttpUrl(s.officialUrl)) {
      pushIssue({
        scholarshipId: s.id,
        scholarshipTitle: s.title,
        issueType: 'Missing Official URL',
        severity: 'High',
        description: 'Scholarship lacks a valid official http(s) application URL.',
        recommendedCorrection: 'Add the official government or issuing authority application portal URL.',
      });
    }

    // Missing deadline
    const deadlineTrimmed = (s.applicationDeadline ?? '').trim();
    const isMissingDeadline =
      !deadlineTrimmed ||
      (s.applicationStatus === 'Currently accepting applications' &&
        /check official portal|unknown|tbd|n\/a/i.test(deadlineTrimmed));
    if (isMissingDeadline) {
      pushIssue({
        scholarshipId: s.id,
        scholarshipTitle: s.title,
        issueType: 'Missing Deadline',
        severity: s.applicationStatus === 'Currently accepting applications' ? 'High' : 'Medium',
        description:
          s.applicationStatus === 'Currently accepting applications'
            ? 'Marked "Currently accepting applications" without a concrete YYYY-MM-DD deadline.'
            : 'Application deadline is empty.',
        recommendedCorrection: 'Record exact YYYY-MM-DD deadline from the official notification or set status to "Status unknown".',
      });
    }

    // Invalid date range
    const startTs = parseScholarshipDeadlineTimestamp(s.applicationStartDate);
    const endTs = parseScholarshipDeadlineTimestamp(s.applicationDeadline);
    if (startTs !== null && endTs !== null && startTs > endTs) {
      pushIssue({
        scholarshipId: s.id,
        scholarshipTitle: s.title,
        issueType: 'Invalid Date Range',
        severity: 'High',
        description: `Application start date (${s.applicationStartDate}) is later than deadline (${s.applicationDeadline}).`,
        recommendedCorrection: 'Correct the start date and deadline to match the official schedule.',
      });
    }

    // Expired record still marked active
    const resolvedCycle = resolveApplicationCycleStatus(s, referenceDate);
    if (
      endTs !== null &&
      endTs < referenceDate.getTime() - 24 * 60 * 60 * 1000 &&
      s.applicationStatus === 'Currently accepting applications'
    ) {
      pushIssue({
        scholarshipId: s.id,
        scholarshipTitle: s.title,
        issueType: 'Expired Marked Active',
        severity: 'High',
        description: `Deadline (${s.applicationDeadline}) has passed, but applicationStatus is still "Currently accepting applications" (resolved as ${resolvedCycle}).`,
        recommendedCorrection: 'Update cycle status to Expired or Closed, or update deadline only after verifying new official cycle dates.',
      });
    }

    // Missing eligibility criteria
    const linkedRules = rules.filter((r) => r.scholarshipId === s.id && r.isActive !== false);
    const hasBaseCriteria =
      typeof s.incomeLimitInr === 'number' ||
      typeof s.minMarksPercent === 'number' ||
      (s.educationLevels && s.educationLevels.length > 0) ||
      (s.allowedCategories && s.allowedCategories.length > 0) ||
      (s.eligibleStates && s.eligibleStates.length > 0);
    if (linkedRules.length === 0 && !hasBaseCriteria) {
      pushIssue({
        scholarshipId: s.id,
        scholarshipTitle: s.title,
        issueType: 'Missing Eligibility Criteria',
        severity: 'Medium',
        description: 'No structured eligibility rules or base criteria (income, marks, education level, category, or state) are defined.',
        recommendedCorrection: 'Configure eligibility criteria in Scholarship Management or Eligibility Rules.',
      });
    }

    // Conflicting income bounds
    if (
      typeof s.minIncomeLimitInr === 'number' &&
      typeof s.incomeLimitInr === 'number' &&
      s.minIncomeLimitInr > s.incomeLimitInr
    ) {
      pushIssue({
        scholarshipId: s.id,
        scholarshipTitle: s.title,
        issueType: 'Conflicting Information',
        severity: 'Critical',
        description: `Minimum income threshold (₹${s.minIncomeLimitInr}) exceeds maximum income limit (₹${s.incomeLimitInr}).`,
        recommendedCorrection: 'Fix income range thresholds immediately so eligibility evaluation does not fail inaccurately.',
      });
    }

    // Incomplete required fields
    const missingEssentials: string[] = [];
    if (!s.description?.trim()) missingEssentials.push('description');
    if (!s.benefitsSummary?.trim() && !s.financialBenefitsText?.trim() && !s.annualAwardInr) {
      missingEssentials.push('financial benefits');
    }
    if (!s.requiredDocuments || s.requiredDocuments.length === 0) {
      missingEssentials.push('required documents');
    }
    if (missingEssentials.length > 0) {
      pushIssue({
        scholarshipId: s.id,
        scholarshipTitle: s.title,
        issueType: 'Incomplete Record',
        severity: 'Low',
        description: `Missing recommended metadata: ${missingEssentials.join(', ')}.`,
        recommendedCorrection: `Populate ${missingEssentials.join(', ')} from the official scheme guidelines.`,
      });
    }

    // Unverified marked as Verified or outdated verification timestamp
    const isVerified = isVerifiedScholarshipStatus(s.verificationStatus);
    if (isVerified) {
      const sourceUrlValid = isValidHttpUrl(s.officialSourceUrl || s.officialUrl);
      const verifiedTs = parseScholarshipDeadlineTimestamp(s.lastVerifiedDate);
      if (!sourceUrlValid || verifiedTs === null) {
        pushIssue({
          scholarshipId: s.id,
          scholarshipTitle: s.title,
          issueType: 'Unverified Source Risk',
          severity: 'High',
          description: 'Scholarship is marked Verified without a valid official source URL or verification date.',
          recommendedCorrection: 'Re-verify in the Verification Queue with authoritative evidence or downgrade to Needs Correction.',
        });
      } else if (referenceDate.getTime() - verifiedTs > oneEightyDaysMs) {
        pushIssue({
          scholarshipId: s.id,
          scholarshipTitle: s.title,
          issueType: 'Outdated Verification',
          severity: 'Medium',
          description: `Last verified on ${s.lastVerifiedDate} (>180 days ago). Academic cycle guidelines may have changed.`,
          recommendedCorrection: 'Re-confirm official portal notification and refresh verification timestamp.',
        });
      }
    }
  }

  return detected;
}

// ============================================================================
// Real Platform & Operational Metrics Calculator
// ============================================================================

export function computeAdminDashboardMetrics(params: {
  profiles: StudentProfile[];
  scholarships: Scholarship[];
  rules: ScholarshipEligibilityRule[];
  applications: ApplicationRecord[];
  documents: DocumentRecord[];
  documentAnalyses: DocumentAnalysis[];
  trustGuardReports: TrustGuardReport[];
  trustGuardAssessments: TrustGuardDocumentAssessment[];
  dataQualityIssues?: DataQualityIssueRecord[];
  referenceDate?: Date;
}): AdminDashboardMetrics {
  const {
    profiles,
    scholarships,
    rules,
    applications,
    documents,
    trustGuardReports,
    trustGuardAssessments,
    referenceDate = new Date(),
  } = params;

  const activeStudentsSet = new Set<string>();
  profiles.forEach((p) => {
    if (p.onboardingCompleted) activeStudentsSet.add(p.uid);
  });
  applications.forEach((a) => activeStudentsSet.add(a.userId));
  documents.forEach((d) => activeStudentsSet.add(d.userId));

  let verifiedScholarships = 0;
  let unverifiedScholarships = 0;
  let expiredScholarships = 0;
  let reviewRequiredScholarships = 0;
  let archivedScholarships = 0;

  for (const s of scholarships) {
    const normVer = normalizeVerificationStatus(s.verificationStatus);
    const effCycle = resolveApplicationCycleStatus(s, referenceDate);

    if (normVer === 'Archived' || s.isActive === false) {
      archivedScholarships++;
    } else if (normVer === 'Verified') {
      verifiedScholarships++;
    } else {
      unverifiedScholarships++;
    }

    if (normVer === 'Pending Review' || normVer === 'Needs Correction' || normVer === 'Unverified') {
      reviewRequiredScholarships++;
    }

    if (normVer === 'Expired' || effCycle === 'Expired' || effCycle === 'Closed') {
      expiredScholarships++;
    }
  }

  const applicationStatusCounts: Record<string, number> = {};
  for (const app of applications) {
    const st = app.status || 'Unknown';
    applicationStatusCounts[st] = (applicationStatusCounts[st] ?? 0) + 1;
  }

  const documentJobsByStatus: AdminDashboardMetrics['platform']['documentJobsByStatus'] = {
    Pending: 0,
    Processing: 0,
    Completed: 0,
    Failed: 0,
    'Needs Review': 0,
  };
  for (const doc of documents) {
    const st: DocumentProcessingStatus =
      doc.processingStatus ??
      (doc.verificationStatus === 'Verified' || doc.verificationStatus === 'Analyzed'
        ? 'Completed'
        : doc.verificationStatus === 'Needs Attention'
          ? 'Needs Review'
          : 'Pending');
    documentJobsByStatus[st] = (documentJobsByStatus[st] ?? 0) + 1;
  }

  const severityCounts: TrustGuardSeverityCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
  let awaitingReview = 0;
  let resolvedFindings = 0;
  let analysisFailures = 0;

  for (const assessment of trustGuardAssessments) {
    severityCounts.critical += assessment.severityCounts?.critical ?? 0;
    severityCounts.high += assessment.severityCounts?.high ?? 0;
    severityCounts.medium += assessment.severityCounts?.medium ?? 0;
    severityCounts.low += assessment.severityCounts?.low ?? 0;
    severityCounts.informational += assessment.severityCounts?.informational ?? 0;

    if (
      assessment.overallVerificationStatus === 'Unable to Verify' ||
      assessment.overallVerificationStatus === 'Manual Review Required'
    ) {
      analysisFailures++;
    }

    for (const f of assessment.findings ?? []) {
      if (f.reviewStatus === 'Unreviewed') awaitingReview++;
      else resolvedFindings++;
    }
  }

  const scannedIssues =
    params.dataQualityIssues && params.dataQualityIssues.length > 0
      ? params.dataQualityIssues
      : runScholarshipDataQualityScan({ scholarships, rules, referenceDate });

  const openIssues = scannedIssues.filter(
    (i) => i.resolutionStatus === 'Open' || i.resolutionStatus === 'Acknowledged'
  );

  return {
    generatedAt: referenceDate.toISOString(),
    platform: {
      totalStudents: profiles.length,
      activeStudentAccounts: activeStudentsSet.size,
      activeStudentDefinition:
        'Students who completed onboarding, uploaded a document, or tracked an application',
      totalScholarships: scholarships.length,
      verifiedScholarships,
      unverifiedScholarships,
      expiredScholarships,
      reviewRequiredScholarships,
      archivedScholarships,
      totalApplications: applications.length,
      applicationStatusCounts,
      documentJobsTotal: documents.length,
      documentJobsByStatus,
      trustGuardReportsTotal: trustGuardReports.length,
      trustGuardOpenReports: trustGuardReports.filter(
        (r) => r.status === 'Open' || r.status === 'Under Review'
      ).length,
      trustGuardAssessmentsTotal: trustGuardAssessments.length,
      trustGuardFindingsBySeverity: severityCounts,
      trustGuardAwaitingReview: awaitingReview,
      trustGuardResolvedFindings: resolvedFindings,
      trustGuardAnalysisFailures: analysisFailures,
    },
    dataQuality: {
      missingOfficialUrls: openIssues.filter((i) => i.issueType === 'Missing Official URL').length,
      missingDeadlines: openIssues.filter((i) => i.issueType === 'Missing Deadline').length,
      missingEligibilityRules: openIssues.filter(
        (i) => i.issueType === 'Missing Eligibility Criteria'
      ).length,
      duplicateCandidates: openIssues.filter((i) => i.issueType === 'Duplicate Candidate').length,
      incompleteRecords: openIssues.filter((i) => i.issueType === 'Incomplete Record').length,
      outdatedVerificationTimestamps: openIssues.filter(
        (i) => i.issueType === 'Outdated Verification' || i.issueType === 'Unverified Source Risk'
      ).length,
      expiredMarkedActive: openIssues.filter((i) => i.issueType === 'Expired Marked Active').length,
      totalOpenIssues: openIssues.length,
    },
  };
}

export function maskEmailForOversight(email?: string): string {
  if (!email || !email.includes('@')) return 'unavailable';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0] ?? '*'}*@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

export function buildSanitizedStudentOversight(params: {
  profiles: StudentProfile[];
  applications: ApplicationRecord[];
  documents: DocumentRecord[];
  trustGuardAssessments: TrustGuardDocumentAssessment[];
}): AdminStudentOversightItem[] {
  const { profiles, applications, documents, trustGuardAssessments } = params;

  const appsByUser = new Map<string, ApplicationRecord[]>();
  applications.forEach((a) => {
    const arr = appsByUser.get(a.userId) ?? [];
    arr.push(a);
    appsByUser.set(a.userId, arr);
  });

  const docsByUser = new Map<string, DocumentRecord[]>();
  documents.forEach((d) => {
    const arr = docsByUser.get(d.userId) ?? [];
    arr.push(d);
    docsByUser.set(d.userId, arr);
  });

  const tgByUser = new Map<string, TrustGuardDocumentAssessment>();
  [...trustGuardAssessments]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .forEach((tg) => {
      if (!tgByUser.has(tg.userId)) tgByUser.set(tg.userId, tg);
    });

  return profiles
    .map((p) => {
      const userApps = appsByUser.get(p.uid) ?? [];
      const userDocs = docsByUser.get(p.uid) ?? [];
      const latestTg = tgByUser.get(p.uid);
      const appStatusCounts: Record<string, number> = {};
      userApps.forEach((a) => {
        appStatusCounts[a.status] = (appStatusCounts[a.status] ?? 0) + 1;
      });
      const failedDocumentCount = userDocs.filter(
        (d) => d.processingStatus === 'Failed' || d.processingStatus === 'Needs Review'
      ).length;

      return {
        uid: p.uid,
        displayName: p.fullName || 'Student',
        maskedEmail: maskEmailForOversight(p.email),
        state: p.state,
        educationLevel: p.educationLevel,
        onboardingCompleted: Boolean(p.onboardingCompleted),
        accountStatus: p.onboardingCompleted
          ? ('Active (Onboarded)' as const)
          : ('Pending Onboarding' as const),
        applicationCount: userApps.length,
        applicationStatusCounts: appStatusCounts,
        documentCount: userDocs.length,
        failedDocumentCount,
        latestTrustGuardStatus: latestTg?.overallVerificationStatus,
        updatedAt: p.updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface TrustGuardSystemSummary {
  totalAssessments: number;
  severityCounts: TrustGuardSeverityCounts;
  awaitingReviewCount: number;
  resolvedCount: number;
  analysisFailuresCount: number;
  repeatedCategories: Array<{ category: string; count: number }>;
  flaggedFindingsPreview: Array<{
    findingId: string;
    userId: string;
    category: string;
    severity: TrustGuardFinding['severity'];
    title: string;
    reviewStatus: TrustGuardFinding['reviewStatus'];
    extractionConfidence: string;
  }>;
}

export function computeTrustGuardMonitorSummary(
  assessments: TrustGuardDocumentAssessment[]
): TrustGuardSystemSummary {
  const severityCounts: TrustGuardSeverityCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
  let awaitingReviewCount = 0;
  let resolvedCount = 0;
  let analysisFailuresCount = 0;
  const catCounts = new Map<string, number>();
  const preview: TrustGuardSystemSummary['flaggedFindingsPreview'] = [];

  for (const a of assessments) {
    severityCounts.critical += a.severityCounts?.critical ?? 0;
    severityCounts.high += a.severityCounts?.high ?? 0;
    severityCounts.medium += a.severityCounts?.medium ?? 0;
    severityCounts.low += a.severityCounts?.low ?? 0;
    severityCounts.informational += a.severityCounts?.informational ?? 0;

    if (
      a.overallVerificationStatus === 'Unable to Verify' ||
      a.overallVerificationStatus === 'Manual Review Required'
    ) {
      analysisFailuresCount++;
    }

    for (const f of a.findings ?? []) {
      if (f.reviewStatus === 'Unreviewed') awaitingReviewCount++;
      else resolvedCount++;
      catCounts.set(f.category, (catCounts.get(f.category) ?? 0) + 1);
      if (preview.length < 40) {
        preview.push({
          findingId: f.findingId,
          userId: a.userId,
          category: f.category,
          severity: f.severity,
          title: f.title,
          reviewStatus: f.reviewStatus,
          extractionConfidence: f.extractionConfidence,
        });
      }
    }
  }

  const repeatedCategories = Array.from(catCounts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalAssessments: assessments.length,
    severityCounts,
    awaitingReviewCount,
    resolvedCount,
    analysisFailuresCount,
    repeatedCategories,
    flaggedFindingsPreview: preview,
  };
}
