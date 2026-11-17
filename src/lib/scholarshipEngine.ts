import {
  evaluateDeterministicEligibility,
  isScholarshipSourceVerified,
  parseScholarshipDeadlineTimestamp,
  resolveApplicationCycleStatus,
} from './eligibilityEngine.ts';
import type {
  ApplicationCycleStatus,
  Scholarship,
  StudentProfile,
} from '../types/database.ts';

export type SortOption = 'relevant' | 'benefit_desc' | 'deadline_asc' | 'recently_verified';

export interface DiscoveryFilters {
  queryText: string;
  educationLevel: string;
  course: string;
  state: string;
  category: string;
  maxFamilyIncomeInr: number | null;
  gender: string;
  scholarshipType: string;
  applicationStatusFilter: string;
  minBenefitInr: number | null;
  includeExpiredOrClosed: boolean;
  onlySaved: boolean;
}

export const DEFAULT_DISCOVERY_FILTERS: DiscoveryFilters = {
  queryText: '',
  educationLevel: 'All',
  course: '',
  state: 'All',
  category: 'All',
  maxFamilyIncomeInr: null,
  gender: 'All',
  scholarshipType: 'All',
  applicationStatusFilter: 'All',
  minBenefitInr: null,
  includeExpiredOrClosed: true,
  onlySaved: false,
};

export function parseDeadlineTimestamp(deadline?: string): number | null {
  return parseScholarshipDeadlineTimestamp(deadline);
}

export function getEffectiveApplicationStatus(
  scholarship: Scholarship,
  referenceDate: Date = new Date()
): ApplicationCycleStatus {
  return resolveApplicationCycleStatus(scholarship, referenceDate);
}

export function isVerifiedStatus(status: Scholarship['verificationStatus']): boolean {
  return isScholarshipSourceVerified(status);
}

export function computeRelevanceScore(
  scholarship: Scholarship,
  profile: StudentProfile | null
): number {
  let score = 0;
  const effectiveStatus = getEffectiveApplicationStatus(scholarship);
  if (effectiveStatus === 'Expired' || effectiveStatus === 'Closed') {
    score -= 50;
  } else if (effectiveStatus === 'Currently accepting applications') {
    score += 20;
  }

  if (isVerifiedStatus(scholarship.verificationStatus)) {
    score += 10;
  }

  if (!profile) {
    return (
      score +
      (scholarship.annualAwardInr ? Math.min(20, Math.round(scholarship.annualAwardInr / 5000)) : 0)
    );
  }

  const evalRes = evaluateDeterministicEligibility(profile, scholarship);
  if (evalRes.overallStatus === 'Eligible') {
    score += 60 + Math.round(evalRes.compatibilityScore * 0.2);
  } else if (evalRes.overallStatus === 'Potentially Eligible') {
    score += 30 + Math.round(evalRes.compatibilityScore * 0.15);
  } else if (evalRes.overallStatus === 'Insufficient Information') {
    score += 10;
  } else {
    // Not Eligible or Scholarship Status Unverified
    score -= 40;
  }

  if (profile.courseSpecialization && scholarship.eligibleCourses?.length) {
    const courseLower = profile.courseSpecialization.toLowerCase();
    const matchedCourse = scholarship.eligibleCourses.some(
      (c) =>
        c.toLowerCase().includes(courseLower) || courseLower.includes(c.toLowerCase().split(' ')[0])
    );
    if (matchedCourse) score += 12;
  }

  return score;
}

export function filterAndSortScholarships(
  scholarships: Scholarship[],
  filters: DiscoveryFilters,
  sortBy: SortOption,
  profile: StudentProfile | null,
  savedIds: Set<string>,
  referenceDate: Date = new Date()
): Array<{
  scholarship: Scholarship;
  effectiveStatus: ApplicationCycleStatus;
  relevanceScore: number;
}> {
  const q = filters.queryText.trim().toLowerCase();
  const courseQuery = filters.course.trim().toLowerCase();

  const filtered = scholarships
    .map((scholarship) => ({
      scholarship,
      effectiveStatus: getEffectiveApplicationStatus(scholarship, referenceDate),
      relevanceScore: computeRelevanceScore(scholarship, profile),
    }))
    .filter(({ scholarship, effectiveStatus }) => {
      if (
        !filters.includeExpiredOrClosed &&
        (effectiveStatus === 'Expired' || effectiveStatus === 'Closed')
      ) {
        return false;
      }

      if (filters.onlySaved && !savedIds.has(scholarship.id)) {
        return false;
      }

      if (filters.scholarshipType !== 'All') {
        const normalizedType =
          scholarship.scholarshipType === 'Private Foundation'
            ? 'Private'
            : scholarship.scholarshipType;
        if (
          normalizedType !== filters.scholarshipType &&
          scholarship.scholarshipType !== filters.scholarshipType
        ) {
          return false;
        }
      }

      if (filters.educationLevel !== 'All') {
        if (
          !scholarship.educationLevels ||
          !scholarship.educationLevels.includes(filters.educationLevel)
        ) {
          return false;
        }
      }

      if (courseQuery) {
        const courseHay = [
          ...(scholarship.eligibleCourses ?? []),
          scholarship.description ?? '',
          scholarship.eligibilitySummary ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!courseHay.includes(courseQuery)) {
          return false;
        }
      }

      if (filters.state !== 'All') {
        const states = scholarship.eligibleStates ?? ['All India'];
        if (!states.includes('All India') && !states.includes(filters.state)) {
          return false;
        }
      }

      if (filters.category !== 'All') {
        if (
          scholarship.allowedCategories &&
          scholarship.allowedCategories.length > 0 &&
          !scholarship.allowedCategories.includes(filters.category)
        ) {
          return false;
        }
      }

      if (filters.maxFamilyIncomeInr !== null && !Number.isNaN(filters.maxFamilyIncomeInr)) {
        if (
          typeof scholarship.incomeLimitInr === 'number' &&
          filters.maxFamilyIncomeInr > scholarship.incomeLimitInr
        ) {
          return false;
        }
        if (
          typeof scholarship.minIncomeLimitInr === 'number' &&
          filters.maxFamilyIncomeInr < scholarship.minIncomeLimitInr
        ) {
          return false;
        }
      }

      if (filters.gender !== 'All') {
        const restriction = scholarship.genderRestriction ?? 'All';
        if (restriction !== 'All' && restriction !== filters.gender) {
          return false;
        }
      }

      if (filters.applicationStatusFilter !== 'All') {
        if (effectiveStatus !== filters.applicationStatusFilter) {
          return false;
        }
      }

      if (filters.minBenefitInr !== null && filters.minBenefitInr > 0) {
        if ((scholarship.annualAwardInr ?? 0) < filters.minBenefitInr) {
          return false;
        }
      }

      if (q) {
        const hay = [
          scholarship.title,
          scholarship.provider,
          scholarship.scholarshipType,
          scholarship.description ?? '',
          scholarship.benefitsSummary ?? '',
          scholarship.financialBenefitsText ?? '',
          scholarship.eligibilitySummary ?? '',
          ...(scholarship.eligibleCourses ?? []),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) {
          return false;
        }
      }

      return true;
    });

  filtered.sort((a, b) => {
    if (sortBy === 'benefit_desc') {
      return (b.scholarship.annualAwardInr ?? 0) - (a.scholarship.annualAwardInr ?? 0);
    }

    if (sortBy === 'deadline_asc') {
      const aExp = a.effectiveStatus === 'Expired' || a.effectiveStatus === 'Closed' ? 1 : 0;
      const bExp = b.effectiveStatus === 'Expired' || b.effectiveStatus === 'Closed' ? 1 : 0;
      if (aExp !== bExp) return aExp - bExp;

      const aTs = parseDeadlineTimestamp(a.scholarship.applicationDeadline);
      const bTs = parseDeadlineTimestamp(b.scholarship.applicationDeadline);
      if (aTs !== null && bTs !== null) return aTs - bTs;
      if (aTs !== null) return -1;
      if (bTs !== null) return 1;
      return b.relevanceScore - a.relevanceScore;
    }

    if (sortBy === 'recently_verified') {
      const aDate = a.scholarship.lastVerifiedDate || a.scholarship.updatedAt;
      const bDate = b.scholarship.lastVerifiedDate || b.scholarship.updatedAt;
      return bDate.localeCompare(aDate);
    }

    return b.relevanceScore - a.relevanceScore;
  });

  return filtered;
}

export function rankRecommendedScholarships(
  scholarships: Scholarship[],
  profile: StudentProfile | null,
  limit = 4,
  referenceDate: Date = new Date()
): Array<{
  scholarship: Scholarship;
  effectiveStatus: ApplicationCycleStatus;
  relevanceScore: number;
  compatibilityScore: number;
  overallStatus: ReturnType<typeof evaluateDeterministicEligibility>['overallStatus'];
}> {
  return scholarships
    .map((scholarship) => {
      const evalRes = evaluateDeterministicEligibility(profile, scholarship, referenceDate);
      return {
        scholarship,
        effectiveStatus: evalRes.effectiveApplicationStatus,
        relevanceScore: computeRelevanceScore(scholarship, profile),
        compatibilityScore: evalRes.compatibilityScore,
        overallStatus: evalRes.overallStatus,
      };
    })
    .filter(
      ({ effectiveStatus, overallStatus }) =>
        effectiveStatus !== 'Expired' &&
        effectiveStatus !== 'Closed' &&
        overallStatus !== 'Not Eligible' &&
        overallStatus !== 'Scholarship Status Unverified'
    )
    .sort((a, b) => {
      // Surface confirmed Eligible above Potentially Eligible & Insufficient Information
      const tier = (status: typeof a.overallStatus) =>
        status === 'Eligible' ? 3 : status === 'Potentially Eligible' ? 2 : 1;
      const tierDiff = tier(b.overallStatus) - tier(a.overallStatus);
      if (tierDiff !== 0) return tierDiff;
      return b.relevanceScore - a.relevanceScore;
    })
    .slice(0, limit);
}
