import assert from 'node:assert/strict';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../src/data/verifiedScholarships.ts';
import { runScholarshipDataQualityScan } from '../src/lib/adminGovernanceEngine.ts';
import { evaluateDeterministicEligibility } from '../src/lib/eligibilityEngine.ts';
import { getScholarshipById, getScholarships } from '../src/lib/firestoreRepo.ts';
import {
  DEFAULT_DISCOVERY_FILTERS,
  filterAndSortScholarships,
  rankRecommendedScholarships,
} from '../src/lib/scholarshipEngine.ts';
import {
  buildGroundedCompanionContext,
  fetchLiveScholarshipsFromDb,
  type StudentDatabaseSnapshot,
} from '../src/server/companionContext.ts';
import type { StudentProfile } from '../src/types/database.ts';

const ORIGINAL_16_IDS = [
  'nsp-central-sector-college-university',
  'nsp-post-matric-sc',
  'nsp-post-matric-st',
  'wb-svmcm-scholarship',
  'mahadbt-rajarshi-shahu-ebc',
  'mahadbt-post-matric-sc',
  'reliance-foundation-ug-scholarship',
  'azim-premji-foundation-scholarship',
  'hdfc-parivartan-ecss',
  'tata-trusts-education-grants',
  'ugc-ishan-uday-ner',
  'ugc-pg-indira-gandhi-single-girl',
  'dst-inspire-she-scholarship',
  'aicte-saksham-pwd-technical',
  'aicte-pragati-girls-technical',
  'nsp-post-matric-minorities',
];

function makeProfile(overrides: Partial<StudentProfile>): StudentProfile {
  return {
    uid: 'jh-test-user',
    fullName: 'Aarav Munda',
    email: 'aarav@example.com',
    state: 'Jharkhand',
    district: 'Ranchi',
    gender: 'Male',
    category: 'ST',
    disabilityStatus: 'None',
    educationLevel: 'Undergraduate (UG)',
    courseSpecialization: 'B.Tech Computer Science',
    previousMarksPercent: 72,
    familyAnnualIncomeInr: 180000,
    onboardingCompleted: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function runEkalyanTests() {
  // 1. Preserve all 16 existing scholarships + verify no duplicates
  assert.equal(VERIFIED_INDIAN_SCHOLARSHIPS.length, 17, 'Expected 17 verified scholarships');
  const ids = VERIFIED_INDIAN_SCHOLARSHIPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'Scholarship IDs must be unique');
  for (const origId of ORIGINAL_16_IDS) {
    assert.ok(ids.includes(origId), `Original scholarship ${origId} must remain intact`);
  }

  const ekalyan = VERIFIED_INDIAN_SCHOLARSHIPS.find(
    (s) => s.id === 'jharkhand-ekalyan-post-matric'
  );
  assert.ok(ekalyan, 'Jharkhand E-Kalyan record must exist');

  // 2. Verify authentic official fields and unverified date/amount discipline
  assert.equal(ekalyan.officialUrl, 'https://ekalyan.cgg.gov.in/');
  assert.equal(ekalyan.officialSourceUrl, 'https://www.jharkhand.gov.in/');
  assert.equal(ekalyan.scholarshipType, 'State Government');
  assert.equal(ekalyan.incomeLimitInr, 250000);
  assert.equal(ekalyan.annualAwardInr, null, 'Must not fabricate a fixed rupee award amount');
  assert.equal(ekalyan.applicationStatus, 'Status unknown', 'Must not falsely claim open window');
  assert.equal(
    ekalyan.applicationStartDate,
    'Check official portal for current application dates'
  );
  assert.ok(
    (ekalyan.applicationStartDate?.length ?? 0) <= 60,
    'applicationStartDate must fit firestore.rules <= 60 chars'
  );
  assert.ok(
    (ekalyan.title?.length ?? 0) <= 240 && (ekalyan.provider?.length ?? 0) <= 200,
    'title/provider must satisfy firestore.rules limits'
  );

  // Admin data quality audit check (no duplicate candidates or high/critical errors for E-Kalyan)
  const auditIssues = runScholarshipDataQualityScan({
    scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
    rules: [],
    existingIssues: [],
  });
  const ekalyanCriticalOrHigh = auditIssues.filter(
    (i) =>
      (i.scholarshipId === 'jharkhand-ekalyan-post-matric' ||
        i.relatedScholarshipId === 'jharkhand-ekalyan-post-matric') &&
      (i.severity === 'Critical' || i.severity === 'High' || i.issueType === 'Duplicate Candidate')
  );
  assert.equal(
    ekalyanCriticalOrHigh.length,
    0,
    'Jharkhand E-Kalyan must pass data quality & duplicate check cleanly'
  );

  // 3. Discovery search & filters
  const emptySaved = new Set<string>();
  for (const term of ['E-Kalyan', 'Jharkhand', 'Jharkhand Scholarship', 'Post-Matric Scholarship']) {
    const searchRes = filterAndSortScholarships(
      VERIFIED_INDIAN_SCHOLARSHIPS,
      { ...DEFAULT_DISCOVERY_FILTERS, queryText: term },
      'relevant',
      null,
      emptySaved
    );
    assert.ok(
      searchRes.some((r) => r.scholarship.id === 'jharkhand-ekalyan-post-matric'),
      `Search for "${term}" must return Jharkhand E-Kalyan`
    );
  }

  for (const cat of ['ST', 'SC', 'BC', 'OBC-NCL']) {
    const catRes = filterAndSortScholarships(
      VERIFIED_INDIAN_SCHOLARSHIPS,
      { ...DEFAULT_DISCOVERY_FILTERS, category: cat },
      'relevant',
      null,
      emptySaved
    );
    assert.ok(
      catRes.some((r) => r.scholarship.id === 'jharkhand-ekalyan-post-matric'),
      `Category filter "${cat}" must include Jharkhand E-Kalyan`
    );
  }

  for (const cat of ['General', 'EWS', 'Minority']) {
    const catRes = filterAndSortScholarships(
      VERIFIED_INDIAN_SCHOLARSHIPS,
      { ...DEFAULT_DISCOVERY_FILTERS, category: cat },
      'relevant',
      null,
      emptySaved
    );
    assert.ok(
      !catRes.some((r) => r.scholarship.id === 'jharkhand-ekalyan-post-matric'),
      `Category filter "${cat}" must exclude Jharkhand E-Kalyan`
    );
  }

  const jhStateRes = filterAndSortScholarships(
    VERIFIED_INDIAN_SCHOLARSHIPS,
    { ...DEFAULT_DISCOVERY_FILTERS, state: 'Jharkhand' },
    'relevant',
    null,
    emptySaved
  );
  assert.ok(jhStateRes.some((r) => r.scholarship.id === 'jharkhand-ekalyan-post-matric'));

  const wbStateRes = filterAndSortScholarships(
    VERIFIED_INDIAN_SCHOLARSHIPS,
    { ...DEFAULT_DISCOVERY_FILTERS, state: 'West Bengal' },
    'relevant',
    null,
    emptySaved
  );
  assert.ok(!wbStateRes.some((r) => r.scholarship.id === 'jharkhand-ekalyan-post-matric'));

  // 4. Deterministic Eligibility Checks
  const eligibleSt = makeProfile({ category: 'ST', familyAnnualIncomeInr: 180000 });
  const eligibleSc = makeProfile({ category: 'SC', educationLevel: 'Diploma / Polytechnic' });
  const eligibleObc = makeProfile({ category: 'OBC-NCL', educationLevel: 'Class 11-12', courseSpecialization: 'Class 11 Science' });
  assert.equal(evaluateDeterministicEligibility(eligibleSt, ekalyan).overallStatus, 'Eligible');
  assert.equal(evaluateDeterministicEligibility(eligibleSc, ekalyan).overallStatus, 'Eligible');
  assert.equal(evaluateDeterministicEligibility(eligibleObc, ekalyan).overallStatus, 'Eligible');

  const nonJharkhandStudent = makeProfile({ state: 'Bihar', category: 'ST' });
  const nonJhEval = evaluateDeterministicEligibility(nonJharkhandStudent, ekalyan);
  assert.equal(nonJhEval.overallStatus, 'Not Eligible');
  assert.ok(nonJhEval.failedCriteria.includes('Domicile / State'));

  const jhGeneralStudent = makeProfile({ state: 'Jharkhand', category: 'General' });
  const jhGenEval = evaluateDeterministicEligibility(jhGeneralStudent, ekalyan);
  assert.equal(jhGenEval.overallStatus, 'Not Eligible');
  assert.ok(jhGenEval.failedCriteria.includes('Social Category'));

  const jhOverIncomeStudent = makeProfile({ state: 'Jharkhand', category: 'ST', familyAnnualIncomeInr: 400000 });
  const jhIncEval = evaluateDeterministicEligibility(jhOverIncomeStudent, ekalyan);
  assert.equal(jhIncEval.overallStatus, 'Not Eligible');
  assert.ok(jhIncEval.failedCriteria.includes('Annual Family Income'));

  // 5. Missing profile fields handled gracefully (never falsely eligible)
  const incompleteStudent = makeProfile({
    state: undefined,
    category: undefined,
    familyAnnualIncomeInr: null,
  });
  const incEval = evaluateDeterministicEligibility(incompleteStudent, ekalyan);
  assert.ok(
    incEval.overallStatus === 'Insufficient Information' ||
      incEval.overallStatus === 'Potentially Eligible',
    `Expected Insufficient Information or Potentially Eligible, got ${incEval.overallStatus}`
  );
  assert.ok(incEval.missingProfileFields.some((f) => f.fieldKey === 'state'));
  assert.ok(incEval.missingProfileFields.some((f) => f.fieldKey === 'category'));
  assert.ok(incEval.missingProfileFields.some((f) => f.fieldKey === 'familyAnnualIncomeInr'));

  // 6. Personalized ranking + AI Companion Grounded Context
  const recs = rankRecommendedScholarships(VERIFIED_INDIAN_SCHOLARSHIPS, eligibleSt, 6);
  assert.ok(
    recs.some((r) => r.scholarship.id === 'jharkhand-ekalyan-post-matric' && r.overallStatus === 'Eligible'),
    'Recommended scholarships must include Jharkhand E-Kalyan as Eligible for eligible Jharkhand ST student'
  );

  const snapshot: StudentDatabaseSnapshot = {
    profile: eligibleSt,
    documents: [],
    documentAnalyses: [],
    eligibilityAssessments: [],
    savedScholarships: [],
    applications: [],
    readinessAssessments: [],
    notifications: [],
    sourceMode: 'server-firestore-rest',
  };
  const companionCtx = buildGroundedCompanionContext({
    message: 'Am I eligible for Jharkhand E-Kalyan Post-Matric Scholarship?',
    history: [],
    scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
    snapshot,
  });
  assert.ok(
    companionCtx.serializedContext.includes('jharkhand-ekalyan-post-matric') &&
      companionCtx.serializedContext.includes('https://ekalyan.cgg.gov.in/'),
    'AI Companion context must ground Jharkhand E-Kalyan with official portal link'
  );

  // 7. Live Firestore repo + server catalog integration checks
  const liveClientCatalog = await getScholarships();
  assert.equal(liveClientCatalog.isEmptyDatabase, false);
  assert.equal(liveClientCatalog.items.length, 17, 'Live client catalog must have 17 scholarships');
  assert.ok(
    liveClientCatalog.items.some((s) => s.id === 'jharkhand-ekalyan-post-matric'),
    'getScholarships() must include Jharkhand E-Kalyan'
  );

  const directFetch = await getScholarshipById('jharkhand-ekalyan-post-matric');
  assert.ok(directFetch && directFetch.officialUrl === 'https://ekalyan.cgg.gov.in/');

  const liveServerCatalog = await fetchLiveScholarshipsFromDb();
  assert.equal(liveServerCatalog.length, 17, 'fetchLiveScholarshipsFromDb() must have 17 scholarships');
  assert.ok(liveServerCatalog.some((s) => s.id === 'jharkhand-ekalyan-post-matric'));

  console.log('ALL JHARKHAND E-KALYAN INTEGRATION & VERIFICATION TESTS PASSED (17 schemes, live client + server catalog, search, filters, eligibility, missing fields, AI Companion).');
}

runEkalyanTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Jharkhand E-Kalyan test failed:', err);
    process.exit(1);
  });
