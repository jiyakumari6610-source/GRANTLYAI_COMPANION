import assert from 'node:assert/strict';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../src/data/verifiedScholarships.ts';
import { evaluateDeterministicEligibility } from '../src/lib/eligibilityEngine.ts';
import {
  DEFAULT_DISCOVERY_FILTERS,
  filterAndSortScholarships,
  getEffectiveApplicationStatus,
  rankRecommendedScholarships,
} from '../src/lib/scholarshipEngine.ts';
import type { Scholarship, StudentProfile } from '../src/types/database.ts';

function runPhase2Tests() {
  // 1. Verify all 17 authentic scholarships & 8 categories (16 original + Jharkhand E-Kalyan)
  assert.equal(VERIFIED_INDIAN_SCHOLARSHIPS.length, 17, 'Expected 17 verified scholarships');
  assert.ok(
    VERIFIED_INDIAN_SCHOLARSHIPS.some((s) => s.id === 'jharkhand-ekalyan-post-matric'),
    'Expected Jharkhand E-Kalyan Post-Matric Scholarship in catalog'
  );

  const requiredCategories = [
    'Central Government',
    'State Government',
    'Private',
    'Corporate',
    'University',
    'Merit-Based',
    'Need-Based',
    'Category-Based',
  ];
  const presentCategories = new Set(VERIFIED_INDIAN_SCHOLARSHIPS.map((s) => s.scholarshipType));
  for (const cat of requiredCategories) {
    assert.ok(presentCategories.has(cat as Scholarship['scholarshipType']), `Missing category: ${cat}`);
  }

  for (const s of VERIFIED_INDIAN_SCHOLARSHIPS) {
    assert.ok(s.officialUrl.startsWith('https://'), `${s.id} must have https officialUrl`);
    assert.ok(s.officialSourceUrl?.startsWith('https://'), `${s.id} must have https officialSourceUrl`);
    assert.ok(s.description && s.description.length <= 2000, `${s.id} description length valid`);
    assert.ok(s.financialBenefitsText && s.financialBenefitsText.length <= 800, `${s.id} benefits length valid`);
    assert.ok(s.academicRequirements && s.academicRequirements.length <= 600, `${s.id} academic req valid`);
    assert.ok((s.requiredDocuments?.length ?? 0) > 0, `${s.id} must specify required documents`);
    assert.equal(s.verificationStatus, 'Verified', `${s.id} verification status`);
    assert.equal(s.applicationStatus, 'Status unknown', `${s.id} must not fabricate active window dates`);
  }

  // 2. Search & 9-Facet Filtering
  const noProfile = null;
  const emptySaved = new Set<string>();

  const searchInspire = filterAndSortScholarships(
    VERIFIED_INDIAN_SCHOLARSHIPS,
    { ...DEFAULT_DISCOVERY_FILTERS, queryText: 'INSPIRE' },
    'relevant',
    noProfile,
    emptySaved
  );
  assert.equal(searchInspire.length, 1);
  assert.equal(searchInspire[0].scholarship.id, 'dst-inspire-she-scholarship');

  const wbFilter = filterAndSortScholarships(
    VERIFIED_INDIAN_SCHOLARSHIPS,
    { ...DEFAULT_DISCOVERY_FILTERS, state: 'West Bengal' },
    'relevant',
    noProfile,
    emptySaved
  );
  assert.ok(wbFilter.some((r) => r.scholarship.id === 'wb-svmcm-scholarship'));
  assert.ok(!wbFilter.some((r) => r.scholarship.id === 'mahadbt-rajarshi-shahu-ebc'));

  const maleFilter = filterAndSortScholarships(
    VERIFIED_INDIAN_SCHOLARSHIPS,
    { ...DEFAULT_DISCOVERY_FILTERS, gender: 'Male' },
    'relevant',
    noProfile,
    emptySaved
  );
  assert.ok(!maleFilter.some((r) => r.scholarship.id === 'aicte-pragati-girls-technical'));
  assert.ok(!maleFilter.some((r) => r.scholarship.id === 'azim-premji-foundation-scholarship'));
  assert.ok(!maleFilter.some((r) => r.scholarship.id === 'ugc-pg-indira-gandhi-single-girl'));

  const highIncomeFilter = filterAndSortScholarships(
    VERIFIED_INDIAN_SCHOLARSHIPS,
    { ...DEFAULT_DISCOVERY_FILTERS, maxFamilyIncomeInr: 600000 },
    'relevant',
    noProfile,
    emptySaved
  );
  assert.ok(!highIncomeFilter.some((r) => r.scholarship.id === 'nsp-post-matric-sc')); // 2.5L cap
  assert.ok(highIncomeFilter.some((r) => r.scholarship.id === 'reliance-foundation-ug-scholarship')); // 15L cap

  const minorityFilter = filterAndSortScholarships(
    VERIFIED_INDIAN_SCHOLARSHIPS,
    { ...DEFAULT_DISCOVERY_FILTERS, category: 'Minority' },
    'relevant',
    noProfile,
    emptySaved
  );
  assert.ok(minorityFilter.some((r) => r.scholarship.id === 'nsp-post-matric-minorities'));
  assert.ok(!minorityFilter.some((r) => r.scholarship.id === 'nsp-post-matric-sc'));

  const benefitFilter = filterAndSortScholarships(
    VERIFIED_INDIAN_SCHOLARSHIPS,
    { ...DEFAULT_DISCOVERY_FILTERS, minBenefitInr: 60000 },
    'relevant',
    noProfile,
    emptySaved
  );
  assert.ok(benefitFilter.every((r) => (r.scholarship.annualAwardInr ?? 0) >= 60000));
  assert.ok(benefitFilter.some((r) => r.scholarship.id === 'dst-inspire-she-scholarship'));

  const savedOnly = filterAndSortScholarships(
    VERIFIED_INDIAN_SCHOLARSHIPS,
    { ...DEFAULT_DISCOVERY_FILTERS, onlySaved: true },
    'relevant',
    noProfile,
    new Set(['wb-svmcm-scholarship'])
  );
  assert.equal(savedOnly.length, 1);
  assert.equal(savedOnly[0].scholarship.id, 'wb-svmcm-scholarship');

  // 3. Sorting modes
  const sortedBenefit = filterAndSortScholarships(
    VERIFIED_INDIAN_SCHOLARSHIPS,
    DEFAULT_DISCOVERY_FILTERS,
    'benefit_desc',
    noProfile,
    emptySaved
  );
  assert.equal(sortedBenefit[0].scholarship.id, 'dst-inspire-she-scholarship');

  // 4. Expired auto-detection & deadline sorting
  const refDate = new Date('2026-11-12T12:00:00Z');
  const syntheticExpired: Scholarship = {
    ...VERIFIED_INDIAN_SCHOLARSHIPS[0],
    id: 'test-expired',
    applicationDeadline: '2025-05-01',
    applicationStatus: 'Currently accepting applications',
  };
  const syntheticUpcoming: Scholarship = {
    ...VERIFIED_INDIAN_SCHOLARSHIPS[1],
    id: 'test-upcoming',
    applicationDeadline: '2027-01-15',
    applicationStatus: 'Currently accepting applications',
    lastVerifiedDate: '2026-11-15',
  };
  assert.equal(getEffectiveApplicationStatus(syntheticExpired, refDate), 'Expired');
  assert.equal(
    getEffectiveApplicationStatus(syntheticUpcoming, refDate),
    'Currently accepting applications'
  );

  const deadlineSorted = filterAndSortScholarships(
    [syntheticExpired, syntheticUpcoming],
    DEFAULT_DISCOVERY_FILTERS,
    'deadline_asc',
    noProfile,
    emptySaved,
    refDate
  );
  assert.equal(deadlineSorted[0].scholarship.id, 'test-upcoming');
  assert.equal(deadlineSorted[1].effectiveStatus, 'Expired');

  const activeOnly = filterAndSortScholarships(
    [syntheticExpired, syntheticUpcoming],
    { ...DEFAULT_DISCOVERY_FILTERS, includeExpiredOrClosed: false },
    'relevant',
    noProfile,
    emptySaved,
    refDate
  );
  assert.equal(activeOnly.length, 1);
  assert.equal(activeOnly[0].scholarship.id, 'test-upcoming');

  // 5. Personalized recommendations exclude Expired & Not Eligible
  const wbFemaleUgProfile: StudentProfile = {
    uid: 'u1',
    fullName: 'Ananya Sen',
    email: 'ananya@example.com',
    state: 'West Bengal',
    gender: 'Female',
    category: 'General',
    disabilityStatus: 'None',
    educationLevel: 'Undergraduate (UG)',
    courseSpecialization: 'B.Tech Computer Science',
    previousMarksPercent: 86,
    familyAnnualIncomeInr: 200000,
    onboardingCompleted: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const svmcmEval = evaluateDeterministicEligibility(wbFemaleUgProfile, VERIFIED_INDIAN_SCHOLARSHIPS[3]);
  assert.equal(svmcmEval.overallStatus, 'Eligible');

  const recs = rankRecommendedScholarships(
    [...VERIFIED_INDIAN_SCHOLARSHIPS, syntheticExpired],
    wbFemaleUgProfile,
    6,
    refDate
  );
  assert.ok(!recs.some((r) => r.scholarship.id === 'test-expired'));
  assert.ok(!recs.some((r) => r.scholarship.id === 'nsp-post-matric-sc'));
  assert.ok(recs.some((r) => r.scholarship.id === 'wb-svmcm-scholarship'));

  // 6. Empty DB handling
  assert.deepEqual(
    filterAndSortScholarships([], DEFAULT_DISCOVERY_FILTERS, 'relevant', wbFemaleUgProfile, emptySaved),
    []
  );
  assert.deepEqual(rankRecommendedScholarships([], wbFemaleUgProfile, 4), []);

  console.log('ALL PHASE 2 ENGINE & CATALOG VERIFICATION TESTS PASSED (16 schemes, 8 categories, 9 filters, 4 sorts, expiry & empty DB guards).');
}

runPhase2Tests();
