import type {
  ApplicationCycleStatus,
  CriterionEvaluationStatus,
  DocumentRecord,
  EligibilityCriterionResult,
  EligibilityOverallStatus,
  Scholarship,
  ScholarshipEligibilityRule,
  StudentProfile,
} from '../types/database.ts';

export interface MissingProfileField {
  fieldKey: keyof StudentProfile;
  label: string;
  reason: string;
}

export interface EligibilityEvaluationResult {
  overallStatus: EligibilityOverallStatus;
  compatibilityScore: number;
  scoreFormulaSummary: string;
  passedCriteria: string[];
  failedCriteria: string[];
  unknownCriteria: string[];
  notApplicableCriteria: string[];
  missingProfileFields: MissingProfileField[];
  criteriaBreakdown: EligibilityCriterionResult[];
  effectiveApplicationStatus: ApplicationCycleStatus;
  ruleVersionUsed?: number;
  rulesAppliedCount?: number;
}

export function parseScholarshipDeadlineTimestamp(deadline?: string): number | null {
  if (!deadline) return null;
  const trimmed = deadline.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return null;
  }
  const ts = Date.parse(trimmed);
  return Number.isNaN(ts) ? null : ts;
}

export function resolveApplicationCycleStatus(
  scholarship: Scholarship,
  referenceDate: Date = new Date()
): ApplicationCycleStatus {
  const explicit = scholarship.applicationStatus;
  if (explicit === 'Closed' || explicit === 'Expired') {
    return explicit;
  }

  const deadlineTs = parseScholarshipDeadlineTimestamp(scholarship.applicationDeadline);
  if (deadlineTs !== null) {
    const startOfToday = new Date(
      referenceDate.getFullYear(),
      referenceDate.getMonth(),
      referenceDate.getDate()
    ).getTime();
    if (deadlineTs < startOfToday) {
      return 'Expired';
    }
  }

  if (
    explicit === 'Currently accepting applications' ||
    explicit === 'Upcoming' ||
    explicit === 'Status unknown'
  ) {
    return explicit;
  }

  return 'Status unknown';
}

export function isScholarshipSourceVerified(status: Scholarship['verificationStatus']): boolean {
  return status === 'Verified' || status === 'Verified Official Source';
}

const ALL_STANDARD_CATEGORIES = ['General', 'OBC-NCL', 'SC', 'ST', 'EWS', 'Minority'] as const;

type CourseDomain =
  | 'engineering_tech'
  | 'medical'
  | 'basic_science'
  | 'arts_commerce_humanities'
  | 'school'
  | 'phd';

function detectCourseDomains(text: string): Set<CourseDomain> {
  const lower = text.toLowerCase();
  const domains = new Set<CourseDomain>();

  if (
    /\b(b\.?\s?tech|btech|b\.?\s?e|m\.?\s?tech|mtech|engineering|polytechnic|diploma|iti|computer science|cse|ece|mechanical|civil|electrical|b\.?\s?arch|architecture|mca|bca)\b/.test(
      lower
    )
  ) {
    domains.add('engineering_tech');
  }
  if (
    /\b(mbbs|bds|bams|bhms|medical|healthcare|nursing|b\.?\s?pharm|m\.?\s?pharm|pharmacy|paramedical|physiotherapy)\b/.test(
      lower
    )
  ) {
    domains.add('medical');
  }
  if (
    /\b(b\.?\s?sc|bsc|b\.?\s?s\b|m\.?\s?sc|msc|physics|chemistry|mathematics|math|biology|biotech|statistics|geology|botany|zoology|basic science|natural science)\b/.test(
      lower
    )
  ) {
    domains.add('basic_science');
  }
  if (
    /\b(b\.?\s?a\b|ba\b|b\.?\s?com|bcom|m\.?\s?a\b|m\.?\s?com|mcom|arts|commerce|humanities|economics|history|sociology|political|english|literature|bba|mba|management|law|llb|design|b\.?\s?ed)\b/.test(
      lower
    )
  ) {
    domains.add('arts_commerce_humanities');
  }
  if (/\b(class 11|class 12|11th|12th|higher secondary|senior secondary|hsc|intermediate)\b/.test(lower)) {
    domains.add('school');
  }
  if (/\b(phd|ph\.d|doctoral|m\.phil)\b/.test(lower)) {
    domains.add('phd');
  }

  return domains;
}

function evaluateCourseStreamMatch(
  studentCourse: string,
  eligibleCourses: string[]
): { status: CriterionEvaluationStatus; detail: string } {
  const joined = eligibleCourses.join(' | ').toLowerCase();
  const isOpenToAllRegular =
    joined.includes('all regular') ||
    joined.includes('all recognized') ||
    joined.includes('general & professional') ||
    joined.includes('ug & pg degree courses');

  if (isOpenToAllRegular) {
    return {
      status: 'Passed',
      detail: `Your course (${studentCourse}) fits the scheme's broad eligible stream scope (${eligibleCourses.join(', ')}).`,
    };
  }

  const studentLower = studentCourse.toLowerCase();
  const studentDomains = detectCourseDomains(studentLower);

  // Explicit INSPIRE SHE Basic & Natural Sciences rule (excludes B.Tech/MBBS/Commerce/Arts)
  if (joined.includes('b.sc / b.s.') && joined.includes('physics')) {
    if (studentDomains.has('basic_science')) {
      return {
        status: 'Passed',
        detail: `Course (${studentCourse}) aligns with eligible Basic & Natural Sciences streams.`,
      };
    }
    if (studentDomains.size > 0) {
      return {
        status: 'Failed',
        detail: `Scheme covers Basic & Natural Sciences (B.Sc./B.S./Int. M.Sc.); "${studentCourse}" falls outside eligible basic science courses.`,
      };
    }
  }

  // Explicit AICTE technical degree/diploma check
  if (joined.includes('aicte approved') || (joined.includes('b.tech') && joined.includes('polytechnic') && !joined.includes('arts'))) {
    const isTechnical =
      studentDomains.has('engineering_tech') ||
      /\b(pharmacy|b\.?\s?pharm|management|mba|hotel management)\b/.test(studentLower);
    if (isTechnical) {
      return {
        status: 'Passed',
        detail: `Course (${studentCourse}) aligns with AICTE-approved Technical Degree/Diploma eligibility.`,
      };
    }
    if (studentDomains.size > 0) {
      return {
        status: 'Failed',
        detail: `Scheme is designated for AICTE-approved Technical Degree/Diploma programmes; "${studentCourse}" does not match.`,
      };
    }
  }

  // Explicit UGC Non-Professional PG check (M.A / M.Sc / M.Com)
  if (joined.includes('non-professional pg')) {
    const isProfessional = /\b(b\.?\s?tech|m\.?\s?tech|mbbs|mba|mca|llb|b\.?\s?ed|m\.?\s?ed|pharmacy|m\.?\s?pharm)\b/.test(
      studentLower
    );
    if (isProfessional) {
      return {
        status: 'Failed',
        detail: `Scheme covers non-professional Master's degrees (M.A/M.Sc/M.Com); professional degree "${studentCourse}" is excluded.`,
      };
    }
    if (studentDomains.has('arts_commerce_humanities') || studentDomains.has('basic_science')) {
      return {
        status: 'Passed',
        detail: `Course (${studentCourse}) aligns with eligible non-professional Master's degree streams.`,
      };
    }
  }

  // Generic domain + keyword intersection
  const schemeDomains = detectCourseDomains(joined);
  for (const d of studentDomains) {
    if (schemeDomains.has(d)) {
      return {
        status: 'Passed',
        detail: `Your course (${studentCourse}) matches eligible streams (${eligibleCourses.join(', ')}).`,
      };
    }
  }

  const normalizedTokens = studentLower
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !['and', 'the', 'for', 'with', 'in', 'of'].includes(t));
  if (normalizedTokens.some((tok) => joined.includes(tok))) {
    return {
      status: 'Passed',
      detail: `Your course (${studentCourse}) matches eligible streams (${eligibleCourses.join(', ')}).`,
    };
  }

  if (studentDomains.size > 0 && schemeDomains.size > 0) {
    return {
      status: 'Failed',
      detail: `Eligible streams are ${eligibleCourses.join(', ')}; profile course "${studentCourse}" does not match.`,
    };
  }

  return {
    status: 'Unknown',
    detail: `Could not confirm whether "${studentCourse}" falls under: ${eligibleCourses.join(', ')}. Clarify exact degree/stream name in Profile.`,
  };
}

export function computeProfileCompleteness(profile: StudentProfile | null): {
  percent: number;
  missingFields: string[];
} {
  if (!profile) {
    return {
      percent: 0,
      missingFields: [
        'Full name & contact',
        'State & district',
        'Category & gender',
        'Education level & course',
        'Institution & academic year',
        'Previous academic marks',
        'Family annual income',
        'Relevant certificates checklist',
      ],
    };
  }

  const checks: Array<{ label: string; ok: boolean }> = [
    { label: 'Full name', ok: Boolean(profile.fullName?.trim()) },
    { label: 'Phone number', ok: Boolean(profile.phone?.trim()) },
    { label: 'State & district', ok: Boolean(profile.state && profile.district?.trim()) },
    { label: 'Date of birth', ok: Boolean(profile.dateOfBirth) },
    { label: 'Gender', ok: Boolean(profile.gender) },
    { label: 'Category', ok: Boolean(profile.category) },
    { label: 'Disability status', ok: Boolean(profile.disabilityStatus) },
    { label: 'Education level', ok: Boolean(profile.educationLevel) },
    { label: 'Course & specialization', ok: Boolean(profile.courseSpecialization?.trim()) },
    { label: 'Institution name & location', ok: Boolean(profile.institutionName?.trim() && profile.collegeLocation?.trim()) },
    { label: 'Academic year & semester', ok: Boolean(profile.academicYear?.trim() && profile.currentSemesterOrYear?.trim()) },
    { label: 'Previous academic marks', ok: typeof profile.previousMarksPercent === 'number' },
    { label: 'Family annual income', ok: typeof profile.familyAnnualIncomeInr === 'number' },
    { label: 'Parent occupation & hostel status', ok: Boolean(profile.parentOccupation?.trim() && profile.hostelStatus) },
    { label: 'Certificates checklist', ok: Boolean(profile.certificates && profile.certificates.length > 0) },
  ];

  const completed = checks.filter((c) => c.ok).length;
  const missingFields = checks.filter((c) => !c.ok).map((c) => c.label);
  const percent = Math.round((completed / checks.length) * 100);
  return { percent, missingFields };
}

function evaluateCustomRuleAgainstProfile(
  rule: ScholarshipEligibilityRule,
  profile: StudentProfile | null
): EligibilityCriterionResult {
  const key = rule.ruleKey as keyof StudentProfile;
  const rawVal = profile ? profile[key] : undefined;
  const criterionName = `${rule.ruleLabel}${rule.isMandatory ? '' : ' (Optional)'}`;

  if (
    rawVal === undefined ||
    rawVal === null ||
    (typeof rawVal === 'string' && !rawVal.trim()) ||
    (Array.isArray(rawVal) && rawVal.length === 0)
  ) {
    return {
      criterion: criterionName,
      status: 'Unknown',
      detail: `Rule "${rule.ruleLabel}" (${rule.operator} ${rule.ruleValue}) could not be evaluated because "${rule.ruleKey}" is missing from your profile.`,
      ...(profile && key in profile ? {} : {}),
    };
  }

  const op = rule.operator;
  let passed = false;

  if (op === 'lte' || op === 'gte') {
    const numProfile = typeof rawVal === 'number' ? rawVal : Number(rawVal);
    const numRule = Number(rule.ruleValue);
    if (!Number.isFinite(numProfile) || !Number.isFinite(numRule)) {
      return {
        criterion: criterionName,
        status: 'Unknown',
        detail: `Cannot compare non-numeric value for "${rule.ruleLabel}".`,
      };
    }
    passed = op === 'lte' ? numProfile <= numRule : numProfile >= numRule;
  } else if (op === 'eq' || op === 'neq') {
    const left = String(rawVal).trim().toLowerCase();
    const right = rule.ruleValue.trim().toLowerCase();
    passed = op === 'eq' ? left === right : left !== right;
  } else if (op === 'in') {
    const allowed = rule.ruleValue
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (Array.isArray(rawVal)) {
      const normalized = rawVal.map((x) => String(x).trim().toLowerCase());
      passed = normalized.some((v) => allowed.includes(v));
    } else {
      passed = allowed.includes(String(rawVal).trim().toLowerCase());
    }
  } else if (op === 'contains') {
    const needle = rule.ruleValue.trim().toLowerCase();
    const haystack = Array.isArray(rawVal)
      ? rawVal.map((x) => String(x).toLowerCase()).join(' ')
      : String(rawVal).toLowerCase();
    passed = haystack.includes(needle);
  }

  return {
    criterion: criterionName,
    status: passed ? 'Passed' : rule.isMandatory ? 'Failed' : 'Not Applicable',
    detail: passed
      ? `Admin rule "${rule.ruleLabel}" satisfied (${String(rawVal)} ${op} ${rule.ruleValue}).`
      : rule.isMandatory
        ? `Mandatory admin rule "${rule.ruleLabel}" not met (profile: ${String(rawVal)}; required: ${op} ${rule.ruleValue}).`
        : `Optional rule "${rule.ruleLabel}" not matched (${String(rawVal)} vs ${rule.ruleValue}); does not disqualify mandatory eligibility.`,
  };
}

export function evaluateDeterministicEligibility(
  profile: StudentProfile | null,
  scholarship: Scholarship,
  referenceDate: Date = new Date(),
  customRules?: ScholarshipEligibilityRule[]
): EligibilityEvaluationResult {
  const criteria: EligibilityCriterionResult[] = [];
  const effectiveApplicationStatus = resolveApplicationCycleStatus(scholarship, referenceDate);

  // 1. Source Verification Status
  const sourceVerified = isScholarshipSourceVerified(scholarship.verificationStatus);
  criteria.push({
    criterion: 'Verification Status',
    status: sourceVerified ? 'Passed' : 'Failed',
    detail: sourceVerified
      ? `Verified against official source (${scholarship.lastVerifiedDate || 'Official portal record'}).`
      : `Verification status is "${scholarship.verificationStatus}". Official rules and cycle validity are unverified.`,
  });

  // 2. Application Window Status
  if (effectiveApplicationStatus === 'Expired' || effectiveApplicationStatus === 'Closed') {
    criteria.push({
      criterion: 'Application Window',
      status: 'Failed',
      detail: `Application cycle is ${effectiveApplicationStatus}${scholarship.applicationDeadline ? ` (recorded deadline: ${scholarship.applicationDeadline})` : ''}.`,
    });
  } else if (effectiveApplicationStatus === 'Currently accepting applications') {
    criteria.push({
      criterion: 'Application Window',
      status: 'Passed',
      detail: `Currently accepting applications${scholarship.applicationDeadline ? ` until ${scholarship.applicationDeadline}` : ''}.`,
    });
  } else if (effectiveApplicationStatus === 'Upcoming') {
    criteria.push({
      criterion: 'Application Window',
      status: 'Passed',
      detail: 'Upcoming cycle; rule compatibility can be verified ahead of portal opening.',
    });
  } else {
    criteria.push({
      criterion: 'Application Window',
      status: 'Not Applicable',
      detail: 'Seasonal opening/closing dates vary by academic cycle ("Check Official Portal"). Confirm live dates before applying.',
    });
  }

  // 3. Family Annual Income (min & max)
  const hasMaxIncome = typeof scholarship.incomeLimitInr === 'number';
  const hasMinIncome =
    typeof scholarship.minIncomeLimitInr === 'number' && scholarship.minIncomeLimitInr > 0;
  if (!hasMaxIncome && !hasMinIncome) {
    criteria.push({
      criterion: 'Annual Family Income',
      status: 'Not Applicable',
      detail: 'No family income ceiling is mandated for this merit-led scholarship.',
    });
  } else if (profile && typeof profile.familyAnnualIncomeInr === 'number') {
    const minLimit = scholarship.minIncomeLimitInr ?? 0;
    const withinMin = profile.familyAnnualIncomeInr >= minLimit;
    const withinMax = hasMaxIncome
      ? profile.familyAnnualIncomeInr <= scholarship.incomeLimitInr!
      : true;
    const ok = withinMin && withinMax;
    const rangeLabel = hasMaxIncome
      ? `₹${minLimit.toLocaleString('en-IN')} – ₹${scholarship.incomeLimitInr!.toLocaleString('en-IN')}`
      : `>= ₹${minLimit.toLocaleString('en-IN')}`;
    criteria.push({
      criterion: 'Annual Family Income',
      status: ok ? 'Passed' : 'Failed',
      detail: ok
        ? `Reported income (₹${profile.familyAnnualIncomeInr.toLocaleString('en-IN')}) falls within the allowed limit (${rangeLabel}).`
        : `Reported income (₹${profile.familyAnnualIncomeInr.toLocaleString('en-IN')}) does not meet the income requirement (${rangeLabel}).`,
    });
  } else {
    const capText = hasMaxIncome
      ? `ceiling is ₹${scholarship.incomeLimitInr!.toLocaleString('en-IN')}`
      : `minimum threshold is ₹${scholarship.minIncomeLimitInr!.toLocaleString('en-IN')}`;
    criteria.push({
      criterion: 'Annual Family Income',
      status: 'Unknown',
      detail: `Income ${capText}, but annual family income is missing from your profile.`,
      missingFieldKey: 'familyAnnualIncomeInr',
      missingFieldReason: 'Required to verify your household income against the scholarship income limit.',
    });
  }

  // 4. Education Level
  if (!scholarship.educationLevels || scholarship.educationLevels.length === 0) {
    criteria.push({
      criterion: 'Education Level',
      status: 'Not Applicable',
      detail: 'No fixed education tier restriction listed.',
    });
  } else if (profile?.educationLevel) {
    const ok = scholarship.educationLevels.includes(profile.educationLevel);
    criteria.push({
      criterion: 'Education Level',
      status: ok ? 'Passed' : 'Failed',
      detail: ok
        ? `Current level (${profile.educationLevel}) matches eligible levels.`
        : `Requires ${scholarship.educationLevels.join(' or ')}; profile indicates ${profile.educationLevel}.`,
    });
  } else {
    criteria.push({
      criterion: 'Education Level',
      status: 'Unknown',
      detail: `Eligible tiers: ${scholarship.educationLevels.join(', ')}. Your education level is missing.`,
      missingFieldKey: 'educationLevel',
      missingFieldReason: 'Required to confirm your study tier matches eligible levels.',
    });
  }

  // 5. Course / Academic Stream
  if (!scholarship.eligibleCourses || scholarship.eligibleCourses.length === 0) {
    criteria.push({
      criterion: 'Course / Academic Stream',
      status: 'Not Applicable',
      detail: 'No specific course or stream restriction specified.',
    });
  } else if (profile?.courseSpecialization?.trim()) {
    const courseEval = evaluateCourseStreamMatch(
      profile.courseSpecialization.trim(),
      scholarship.eligibleCourses
    );
    criteria.push({
      criterion: 'Course / Academic Stream',
      status: courseEval.status,
      detail: courseEval.detail,
      ...(courseEval.status === 'Unknown'
        ? {
            missingFieldKey: 'courseSpecialization' as keyof StudentProfile,
            missingFieldReason: `Clarify your degree/stream to verify compatibility with: ${scholarship.eligibleCourses.join(', ')}.`,
          }
        : {}),
    });
  } else {
    criteria.push({
      criterion: 'Course / Academic Stream',
      status: 'Unknown',
      detail: `Eligible streams: ${scholarship.eligibleCourses.join(', ')}. Course/specialization is missing.`,
      missingFieldKey: 'courseSpecialization',
      missingFieldReason: 'Required to verify whether your enrolled degree or stream qualifies.',
    });
  }

  // 6. Academic Marks / Qualification
  if (typeof scholarship.minMarksPercent === 'number' && scholarship.minMarksPercent > 0) {
    if (profile && typeof profile.previousMarksPercent === 'number') {
      const ok = profile.previousMarksPercent >= scholarship.minMarksPercent;
      criteria.push({
        criterion: 'Academic Marks',
        status: ok ? 'Passed' : 'Failed',
        detail: ok
          ? `Previous qualifying marks (${profile.previousMarksPercent}%) meet the ${scholarship.minMarksPercent}% benchmark.`
          : `Previous qualifying marks (${profile.previousMarksPercent}%) are below the ${scholarship.minMarksPercent}% requirement.`,
      });
    } else {
      criteria.push({
        criterion: 'Academic Marks',
        status: 'Unknown',
        detail: `Requires at least ${scholarship.minMarksPercent}% in previous qualifying examination; marks are missing.`,
        missingFieldKey: 'previousMarksPercent',
        missingFieldReason: `Required to check if you meet the ${scholarship.minMarksPercent}% merit cutoff.`,
      });
    }
  } else {
    criteria.push({
      criterion: 'Academic Marks',
      status: 'Not Applicable',
      detail: 'No fixed minimum percentage cutoff beyond passing the previous qualifying exam.',
    });
  }

  // 7. Domicile / State Restriction
  const states = scholarship.eligibleStates ?? ['All India'];
  if (states.includes('All India')) {
    criteria.push({
      criterion: 'Domicile / State',
      status: 'Not Applicable',
      detail: 'Open to eligible students across all Indian states and Union Territories.',
    });
  } else if (profile?.state) {
    const ok = states.includes(profile.state);
    criteria.push({
      criterion: 'Domicile / State',
      status: ok ? 'Passed' : 'Failed',
      detail: ok
        ? `Domicile state (${profile.state}) is covered under this scheme.`
        : `Restricted to ${states.join(', ')}; your profile state is ${profile.state}.`,
    });
  } else {
    criteria.push({
      criterion: 'Domicile / State',
      status: 'Unknown',
      detail: `Restricted to ${states.join(', ')}. Your domicile state is missing from your profile.`,
      missingFieldKey: 'state',
      missingFieldReason: `Required because this scholarship only covers ${states.length} specific state(s)/UT(s).`,
    });
  }

  // 8. Social Category
  const allowedCategories = scholarship.allowedCategories ?? [];
  const openToAllCategories =
    allowedCategories.length === 0 ||
    ALL_STANDARD_CATEGORIES.every((c) => allowedCategories.includes(c));
  if (openToAllCategories) {
    criteria.push({
      criterion: 'Social Category',
      status: 'Not Applicable',
      detail: 'Open to all social categories without category-specific restriction.',
    });
  } else if (profile?.category) {
    const ok = allowedCategories.includes(profile.category);
    criteria.push({
      criterion: 'Social Category',
      status: ok ? 'Passed' : 'Failed',
      detail: ok
        ? `Profile category (${profile.category}) is eligible.`
        : `Restricted to ${allowedCategories.join(', ')}; profile shows ${profile.category}.`,
    });
  } else {
    criteria.push({
      criterion: 'Social Category',
      status: 'Unknown',
      detail: `Restricted to ${allowedCategories.join(', ')}. Category information is missing.`,
      missingFieldKey: 'category',
      missingFieldReason: `Required because this scheme only supports ${allowedCategories.join(', ')} applicants.`,
    });
  }

  // 9. Gender Requirement
  if (!scholarship.genderRestriction || scholarship.genderRestriction === 'All') {
    criteria.push({
      criterion: 'Gender Requirement',
      status: 'Not Applicable',
      detail: 'Open to applicants of all genders.',
    });
  } else if (profile?.gender) {
    const ok = profile.gender === scholarship.genderRestriction;
    criteria.push({
      criterion: 'Gender Requirement',
      status: ok ? 'Passed' : 'Failed',
      detail: ok
        ? `Matches gender requirement (${scholarship.genderRestriction}).`
        : `Scheme is exclusively for ${scholarship.genderRestriction} applicants.`,
    });
  } else {
    criteria.push({
      criterion: 'Gender Requirement',
      status: 'Unknown',
      detail: `Designated exclusively for ${scholarship.genderRestriction} applicants; gender is missing.`,
      missingFieldKey: 'gender',
      missingFieldReason: `Required because this scheme is restricted to ${scholarship.genderRestriction} candidates.`,
    });
  }

  // 10. PwD (40%+) Requirement
  if (!scholarship.disabilityRequired) {
    criteria.push({
      criterion: 'PwD (40%+) Criterion',
      status: 'Not Applicable',
      detail: 'Certified benchmark disability is not required for this scheme.',
    });
  } else if (profile?.disabilityStatus) {
    const ok = profile.disabilityStatus === 'PwD (40% or above)';
    criteria.push({
      criterion: 'PwD (40%+) Criterion',
      status: ok ? 'Passed' : 'Failed',
      detail: ok
        ? 'Profile confirms PwD (40% or above) eligibility.'
        : 'Scheme requires certified 40%+ benchmark disability (UDID).',
    });
  } else {
    criteria.push({
      criterion: 'PwD (40%+) Criterion',
      status: 'Unknown',
      detail: 'Requires certified 40%+ benchmark disability status; disability field is missing.',
      missingFieldKey: 'disabilityStatus',
      missingFieldReason: 'Required because this scheme is reserved for PwD (40% or above) students.',
    });
  }

  // 11. Active Admin-Managed Structured Rules (Phase 9)
  const activeCustomRules = (customRules ?? []).filter(
    (r) => r.scholarshipId === scholarship.id && r.isActive !== false
  );
  const optionalFailedCriteriaNames = new Set<string>();
  for (const rule of activeCustomRules) {
    const evaluated = evaluateCustomRuleAgainstProfile(rule, profile);
    criteria.push(evaluated);
    if (!rule.isMandatory && evaluated.status !== 'Passed') {
      optionalFailedCriteriaNames.add(evaluated.criterion);
    }
  }

  const ruleVersionUsed =
    activeCustomRules.length > 0
      ? Math.max(
          scholarship.activeRuleVersion ?? 1,
          ...activeCustomRules.map((r) => r.versionNumber ?? 1)
        )
      : scholarship.activeRuleVersion ?? 1;

  const passedCriteria = criteria.filter((c) => c.status === 'Passed').map((c) => c.criterion);
  const failedCriteria = criteria.filter((c) => c.status === 'Failed').map((c) => c.criterion);
  const unknownCriteria = criteria.filter((c) => c.status === 'Unknown').map((c) => c.criterion);
  const notApplicableCriteria = criteria
    .filter((c) => c.status === 'Not Applicable')
    .map((c) => c.criterion);

  // Deduplicated list of missing profile fields needed to finish evaluation
  const missingMap = new Map<keyof StudentProfile, MissingProfileField>();
  const FIELD_LABELS: Partial<Record<keyof StudentProfile, string>> = {
    familyAnnualIncomeInr: 'Annual Family Income (INR)',
    educationLevel: 'Current Education Level',
    courseSpecialization: 'Course / Specialization',
    previousMarksPercent: 'Previous Academic Marks (%)',
    state: 'Domicile State / UT',
    category: 'Social Category',
    gender: 'Gender',
    disabilityStatus: 'Disability Status',
  };

  for (const c of criteria) {
    if (c.status === 'Unknown' && c.missingFieldKey && !missingMap.has(c.missingFieldKey)) {
      missingMap.set(c.missingFieldKey, {
        fieldKey: c.missingFieldKey,
        label: FIELD_LABELS[c.missingFieldKey] ?? String(c.missingFieldKey),
        reason: c.missingFieldReason ?? c.detail,
      });
    }
  }
  const missingProfileFields = Array.from(missingMap.values());

  // 5-state deterministic classification
  const verificationFailed = criteria.some(
    (c) => c.criterion === 'Verification Status' && c.status === 'Failed'
  );
  const nonVerificationFailed = criteria.some(
    (c) =>
      c.criterion !== 'Verification Status' &&
      c.status === 'Failed' &&
      !optionalFailedCriteriaNames.has(c.criterion)
  );

  // Count applicable profile-specific criteria (exclude Verification Status & Application Window)
  const profileApplicable = criteria.filter(
    (c) =>
      c.criterion !== 'Verification Status' &&
      c.criterion !== 'Application Window' &&
      c.status !== 'Not Applicable'
  );
  const profilePassedCount = profileApplicable.filter((c) => c.status === 'Passed').length;
  const profileUnknownCount = profileApplicable.filter((c) => c.status === 'Unknown').length;

  let overallStatus: EligibilityOverallStatus;
  if (verificationFailed) {
    overallStatus = 'Scholarship Status Unverified';
  } else if (nonVerificationFailed) {
    overallStatus = 'Not Eligible';
  } else if (unknownCriteria.length > 0) {
    if (profilePassedCount === 0 || profileUnknownCount > profilePassedCount) {
      overallStatus = 'Insufficient Information';
    } else {
      overallStatus = 'Potentially Eligible';
    }
  } else {
    overallStatus = 'Eligible';
  }

  // Transparent, bounded Compatibility Score (0–100)
  const applicableCount = criteria.length - notApplicableCriteria.length;
  const rawScore =
    applicableCount > 0 ? Math.round((passedCriteria.length / applicableCount) * 100) : 0;

  let compatibilityScore = rawScore;
  let guardrailNote = '';

  if (overallStatus === 'Scholarship Status Unverified') {
    compatibilityScore = Math.min(rawScore, 60);
    guardrailNote = ' (capped at 60% because official scholarship verification is pending)';
  } else if (overallStatus === 'Not Eligible') {
    compatibilityScore = Math.min(rawScore, 45);
    guardrailNote = ' (capped at 45% because mandatory eligibility criteria failed)';
  } else if (unknownCriteria.length > 0) {
    compatibilityScore = Math.min(rawScore, 95);
    guardrailNote = ' (bounded below 100% until unknown criteria are verified)';
  }

  const scoreFormulaSummary =
    `${passedCriteria.length} of ${applicableCount} applicable criteria passed ` +
    `(${unknownCriteria.length} unknown, ${failedCriteria.length} failed, ` +
    `${notApplicableCriteria.length} not applicable)${guardrailNote}. ` +
    `Rule compatibility score does not guarantee official selection or award.`;

  return {
    overallStatus,
    compatibilityScore,
    scoreFormulaSummary,
    passedCriteria,
    failedCriteria,
    unknownCriteria,
    notApplicableCriteria,
    missingProfileFields,
    criteriaBreakdown: criteria,
    effectiveApplicationStatus,
    ruleVersionUsed,
    rulesAppliedCount: activeCustomRules.length,
  };
}

export function computeReadinessMetrics(
  profile: StudentProfile | null,
  documents: DocumentRecord[],
  targetScholarships: Scholarship[]
): {
  readinessPercent: number;
  profileCompletenessPercent: number;
  documentCoveragePercent: number;
  missingItems: string[];
} {
  const { percent: profileCompletenessPercent, missingFields } = computeProfileCompleteness(profile);

  const requiredDocsPool = new Set<string>();
  targetScholarships.forEach((s) => {
    (s.requiredDocuments ?? []).forEach((d) => requiredDocsPool.add(d));
  });

  if (requiredDocsPool.size === 0) {
    [
      'Aadhaar Card',
      'Income Certificate (Tehsildar / Competent Authority)',
      'Previous Academic Marksheet',
      'Current Year Bonafide / Fee Receipt',
      'Bank Passbook (Aadhaar-Seeded)',
    ].forEach((d) => requiredDocsPool.add(d));
  }

  const uploadedTypes = new Set(documents.map((d) => d.documentType.toLowerCase()));
  const heldCerts = new Set((profile?.certificates ?? []).map((c) => c.toLowerCase()));

  const missingDocs: string[] = [];
  let coveredCount = 0;

  requiredDocsPool.forEach((reqDoc) => {
    const key = reqDoc.toLowerCase();
    const isUploaded =
      uploadedTypes.has(key) ||
      Array.from(uploadedTypes).some((t) => key.includes(t) || t.includes(key.split(' ')[0]));
    const isDeclared = heldCerts.has(key);
    if (isUploaded) {
      coveredCount += 1;
    } else if (isDeclared) {
      coveredCount += 0.5;
      missingDocs.push(`Upload scan for: ${reqDoc}`);
    } else {
      missingDocs.push(`Missing document: ${reqDoc}`);
    }
  });

  const documentCoveragePercent = Math.round((coveredCount / requiredDocsPool.size) * 100);
  const readinessPercent = Math.round(
    profileCompletenessPercent * 0.55 + documentCoveragePercent * 0.45
  );

  return {
    readinessPercent,
    profileCompletenessPercent,
    documentCoveragePercent,
    missingItems: [...missingFields.map((f) => `Complete profile field: ${f}`), ...missingDocs],
  };
}
