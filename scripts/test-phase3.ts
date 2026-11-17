import assert from 'node:assert/strict';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../src/data/verifiedScholarships.ts';
import { evaluateDeterministicEligibility } from '../src/lib/eligibilityEngine.ts';
import { rankRecommendedScholarships } from '../src/lib/scholarshipEngine.ts';
import type {
  EligibilityAssessment,
  EligibilityAssessmentDetail,
  Scholarship,
  StudentProfile,
} from '../src/types/database.ts';

const NOW_ISO = '2026-11-13T00:00:00.000Z';

function makeStudent(overrides: Partial<StudentProfile> = {}): StudentProfile {
  return {
    uid: 'student-test-1',
    fullName: 'Aarav Sharma',
    email: 'aarav@example.com',
    phone: '9876543210',
    state: 'West Bengal',
    district: 'Kolkata',
    dateOfBirth: '2006-05-10',
    gender: 'Male',
    category: 'General',
    disabilityStatus: 'None',
    educationLevel: 'Undergraduate (UG)',
    courseSpecialization: 'B.Tech Computer Science',
    institutionName: 'Jadavpur University',
    collegeLocation: 'Kolkata',
    academicYear: '2026-27',
    currentSemesterOrYear: '1st Year',
    previousMarksPercent: 86,
    familyAnnualIncomeInr: 180000,
    parentOccupation: 'Self-Employed',
    hostelStatus: 'Day Scholar',
    certificates: ['Aadhaar Card'],
    onboardingCompleted: true,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

const csss = VERIFIED_INDIAN_SCHOLARSHIPS.find((s) => s.id === 'nsp-central-sector-college-university')!;
const svmcm = VERIFIED_INDIAN_SCHOLARSHIPS.find((s) => s.id === 'wb-svmcm-scholarship')!;
const inspire = VERIFIED_INDIAN_SCHOLARSHIPS.find((s) => s.id === 'dst-inspire-she-scholarship')!;
const pragati = VERIFIED_INDIAN_SCHOLARSHIPS.find((s) => s.id === 'aicte-pragati-girls-technical')!;

assert.ok(csss && svmcm && inspire && pragati, 'Verified schemes must exist');

// Scenario 1: Student meeting all mandatory requirements -> Eligible (100%)
const s1Profile = makeStudent();
const s1Result = evaluateDeterministicEligibility(s1Profile, svmcm);
assert.equal(s1Result.overallStatus, 'Eligible', `Expected Eligible, got ${s1Result.overallStatus}`);
assert.equal(s1Result.compatibilityScore, 100);
assert.equal(s1Result.failedCriteria.length, 0);
assert.equal(s1Result.unknownCriteria.length, 0);
assert.equal(s1Result.missingProfileFields.length, 0);

// Also check INSPIRE stream enforcement: B.Tech student should fail Course / Academic Stream on INSPIRE SHE
const inspireForBtech = evaluateDeterministicEligibility(s1Profile, inspire);
assert.equal(inspireForBtech.overallStatus, 'Not Eligible');
assert.ok(
  inspireForBtech.failedCriteria.includes('Course / Academic Stream'),
  'B.Tech must fail INSPIRE SHE Basic/Natural Sciences stream rule'
);
assert.ok(inspireForBtech.compatibilityScore <= 45, 'Not Eligible score must be capped <= 45');

// Scenario 2: Student failing an income requirement -> Not Eligible + bounded score
const s2Profile = makeStudent({ familyAnnualIncomeInr: 650000 });
const s2Result = evaluateDeterministicEligibility(s2Profile, csss);
assert.equal(s2Result.overallStatus, 'Not Eligible');
assert.ok(s2Result.failedCriteria.includes('Annual Family Income'));
assert.ok(s2Result.compatibilityScore <= 45, `Score ${s2Result.compatibilityScore} should be <= 45`);

// Scenario 3: Student missing domicile information on state-restricted scheme -> Potentially Eligible
const s3Profile = makeStudent({ state: undefined });
const s3Result = evaluateDeterministicEligibility(s3Profile, svmcm);
assert.equal(
  s3Result.overallStatus,
  'Potentially Eligible',
  `Expected Potentially Eligible, got ${s3Result.overallStatus}`
);
assert.ok(s3Result.unknownCriteria.includes('Domicile / State'));
assert.ok(s3Result.missingProfileFields.some((f) => f.fieldKey === 'state'));
assert.ok(s3Result.compatibilityScore < 100, 'Score must not be 100 when Unknown criteria exist');
// Never re-ask already-present fields
assert.ok(
  !s3Result.missingProfileFields.some((f) => f.fieldKey === 'familyAnnualIncomeInr'),
  'Should not re-ask income when already provided'
);

// Scenario 4: Student with incomplete academic information -> Insufficient Information
const s4Profile = makeStudent({
  educationLevel: undefined,
  courseSpecialization: undefined,
  previousMarksPercent: null,
  familyAnnualIncomeInr: null,
});
const s4Result = evaluateDeterministicEligibility(s4Profile, csss);
assert.equal(
  s4Result.overallStatus,
  'Insufficient Information',
  `Expected Insufficient Information, got ${s4Result.overallStatus}`
);
assert.ok(s4Result.missingProfileFields.some((f) => f.fieldKey === 'educationLevel'));
assert.ok(s4Result.missingProfileFields.some((f) => f.fieldKey === 'courseSpecialization'));
assert.ok(s4Result.missingProfileFields.some((f) => f.fieldKey === 'previousMarksPercent'));
assert.ok(s4Result.missingProfileFields.some((f) => f.fieldKey === 'familyAnnualIncomeInr'));
assert.ok(s4Result.compatibilityScore < 100);

// Scenario 5a: Unverified scholarship -> Scholarship Status Unverified
const unverifiedScheme: Scholarship = {
  ...csss,
  id: 'unverified-test-scheme',
  verificationStatus: 'Pending verification',
};
const s5aResult = evaluateDeterministicEligibility(s1Profile, unverifiedScheme);
assert.equal(s5aResult.overallStatus, 'Scholarship Status Unverified');
assert.ok(s5aResult.failedCriteria.includes('Verification Status'));
assert.ok(s5aResult.compatibilityScore <= 60);

// Scenario 5b: Expired scholarship -> Not Eligible & excluded from recommendations
const expiredScheme: Scholarship = {
  ...csss,
  id: 'expired-test-scheme',
  applicationDeadline: '2024-01-15',
  applicationStatus: 'Currently accepting applications',
};
const s5bResult = evaluateDeterministicEligibility(s1Profile, expiredScheme);
assert.equal(s5bResult.overallStatus, 'Not Eligible');
assert.ok(s5bResult.failedCriteria.includes('Application Window'));
assert.ok(s5bResult.compatibilityScore <= 45);

// Catalogue recommendation exclusion check: excludes Not Eligible, Unverified, Expired
const ranked = rankRecommendedScholarships(
  [...VERIFIED_INDIAN_SCHOLARSHIPS, unverifiedScheme, expiredScheme],
  s1Profile,
  20
);
const rankedIds = new Set(ranked.map((r) => r.scholarship.id));
assert.ok(rankedIds.has(svmcm.id), 'Eligible SVMCM should be recommended');
assert.ok(!rankedIds.has(pragati.id), 'Female-only AICTE Pragati must be excluded for Male student');
assert.ok(!rankedIds.has(unverifiedScheme.id), 'Unverified scheme must be excluded');
assert.ok(!rankedIds.has(expiredScheme.id), 'Expired scheme must be excluded');

// Firestore schema conformity check for EligibilityAssessment & EligibilityAssessmentDetail
const assessmentDoc: EligibilityAssessment = {
  id: 'elig-test-1',
  userId: s1Profile.uid,
  scholarshipId: svmcm.id,
  scholarshipTitle: svmcm.title,
  overallStatus: s1Result.overallStatus,
  compatibilityScore: s1Result.compatibilityScore,
  passedCriteria: s1Result.passedCriteria,
  failedCriteria: s1Result.failedCriteria,
  unknownCriteria: s1Result.unknownCriteria,
  notApplicableCriteria: s1Result.notApplicableCriteria,
  scoreFormulaSummary: s1Result.scoreFormulaSummary,
  criteriaBreakdown: s1Result.criteriaBreakdown,
  aiExplanation: 'Deterministic explanation placeholder.',
  createdAt: NOW_ISO,
};
const detailDocs: EligibilityAssessmentDetail[] = s1Result.criteriaBreakdown.map((c, idx) => ({
  id: `${assessmentDoc.id}-d${idx}`,
  assessmentId: assessmentDoc.id,
  userId: s1Profile.uid,
  scholarshipId: svmcm.id,
  criterion: c.criterion,
  status: c.status,
  detail: c.detail,
  createdAt: NOW_ISO,
}));
assert.equal(detailDocs.length, 10, 'All 10 deterministic criteria must emit detail rows');
assert.ok(
  detailDocs.every((d) => ['Passed', 'Failed', 'Unknown', 'Not Applicable'].includes(d.status))
);

console.log('Phase 3 verification passed (all 5 scenarios + stream rules + score bounds + exclusion + schema checks).');
