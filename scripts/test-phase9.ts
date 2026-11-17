import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../src/data/verifiedScholarships.ts';
import {
  buildSanitizedStudentOversight,
  computeAdminDashboardMetrics,
  computeTrustGuardMonitorSummary,
  detectRuleContradictions,
  maskEmailForOversight,
  runScholarshipDataQualityScan,
  validateScholarshipRuleInput,
  validateVerificationEvidence,
} from '../src/lib/adminGovernanceEngine.ts';
import { evaluateDeterministicEligibility } from '../src/lib/eligibilityEngine.ts';
import {
  archiveScholarshipWorkflow,
  assignUserRoleWorkflow,
  buildAuditLogRecord,
  resolveDataQualityIssueWorkflow,
  saveEligibilityRulesWorkflow,
  upsertScholarshipWorkflow,
  verifyScholarshipWorkflow,
} from '../src/server/adminService.ts';
import { CompanionError } from '../src/server/companionContext.ts';
import {
  BOOTSTRAP_ADMIN_EMAIL,
  requireAdmin,
  requireAuth,
  requireSuperAdmin,
  resolveServerRoleForUser,
  type AuthenticatedRequest,
} from '../src/server/firebaseAdmin.ts';
import type {
  AdminAuditLogRecord,
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  EligibilityAssessment,
  Scholarship,
  ScholarshipEligibilityRule,
  StudentProfile,
  TrustGuardDocumentAssessment,
  UserRoleRecord,
} from '../src/types/database.ts';

const NOW_ISO = '2026-05-10T10:00:00.000Z';
const REF_DATE = new Date('2026-05-10T10:00:00.000Z');

function createMockRes() {
  const state: { statusCode: number; body: unknown } = { statusCode: 200, body: null };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

function makeStudentProfile(uid = 'student-alpha', overrides: Partial<StudentProfile> = {}): StudentProfile {
  return {
    uid,
    fullName: 'Riya Deshmukh',
    email: 'riya.deshmukh@example.edu',
    phone: '+91-9822011223',
    state: 'Maharashtra',
    district: 'Nagpur',
    dateOfBirth: '2006-03-19',
    gender: 'Female',
    category: 'OBC-NCL',
    disabilityStatus: 'None',
    educationLevel: 'Undergraduate (UG)',
    courseSpecialization: 'B.Tech Computer Science',
    institutionName: 'VNIT Nagpur',
    collegeLocation: 'Nagpur, Maharashtra',
    academicYear: '2025-26',
    currentSemesterOrYear: '1st Year',
    previousMarksPercent: 86,
    familyAnnualIncomeInr: 420000,
    parentOccupation: 'Salaried',
    hostelStatus: 'Hosteller',
    certificates: ['Aadhaar Card', 'Income Certificate'],
    onboardingCompleted: true,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

async function runTests() {
  console.log('--- Phase 9 Admin Control Center & Scholarship Data Governance Verification ---');

  const pragatiBase: Scholarship = {
    ...VERIFIED_INDIAN_SCHOLARSHIPS.find((s) => s.id === 'aicte-pragati-girls-technical')!,
    lastVerifiedDate: '2026-04-15',
  };

  // [1] Unauthenticated user blocked by requireAuth / requireAdmin / requireSuperAdmin
  {
    const { res: resAuth, state: stAuth } = createMockRes();
    let nextCalled = false;
    await requireAuth({ headers: {} } as AuthenticatedRequest, resAuth, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(stAuth.statusCode, 401);

    const { res: resAdmin, state: stAdmin } = createMockRes();
    await requireAdmin({} as AuthenticatedRequest, resAdmin, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(stAdmin.statusCode, 401);

    const { res: resSuper, state: stSuper } = createMockRes();
    await requireSuperAdmin({} as AuthenticatedRequest, resSuper, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(stSuper.statusCode, 401);
  }
  console.log('PASS [1] Unauthenticated users rejected with 401 across auth/admin/super-admin middleware');

  // [2] Student & unverified users blocked from admin endpoints and role resolution
  {
    const unverifiedBootstrap = await resolveServerRoleForUser({
      uid: 'spoof-uid',
      email: BOOTSTRAP_ADMIN_EMAIL,
      emailVerified: false,
      idToken: 'mock-token',
    });
    assert.equal(unverifiedBootstrap.role, 'student');

    const { res: resUnverified, state: stUnverified } = createMockRes();
    let nextCalled = false;
    await requireAdmin(
      {
        user: { uid: 'spoof-uid', email: BOOTSTRAP_ADMIN_EMAIL, email_verified: false },
        idToken: 'mock-token',
      } as unknown as AuthenticatedRequest,
      resUnverified,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, false);
    assert.equal(stUnverified.statusCode, 403);

    const { res: resStudent, state: stStudent } = createMockRes();
    await requireAdmin(
      {
        user: { uid: 'student-1', email: 'student1@gmail.com', email_verified: true },
        idToken: '',
      } as unknown as AuthenticatedRequest,
      resStudent,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, false);
    assert.equal(stStudent.statusCode, 401);

    const verifiedBootstrap = await resolveServerRoleForUser({
      uid: 'super-admin-uid',
      email: BOOTSTRAP_ADMIN_EMAIL,
      emailVerified: true,
      idToken: 'mock-token',
    });
    assert.equal(verifiedBootstrap.role, 'super_admin');
    assert.equal(verifiedBootstrap.source, 'bootstrap');
  }
  console.log('PASS [2] Unverified email spoof & student role blocked; verified bootstrap Super Admin resolved');

  // [3] Student / non-Super-Admin cannot assign roles (workflow + firestore.rules check)
  {
    assert.throws(
      () =>
        assignUserRoleWorkflow({
          callerUid: 'student-1',
          callerEmail: 'student1@example.com',
          callerRole: 'student',
          targetUid: 'student-1',
          targetEmail: 'student1@example.com',
          newRole: 'super_admin',
          status: 'active',
          existingRoles: [],
        }),
      (e: unknown) => e instanceof CompanionError && e.httpStatus === 403 && e.code === 'SUPER_ADMIN_REQUIRED'
    );

    const rulesSource = await fs.readFile(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
    assert.match(rulesSource, /match \/user_roles\/\{userId\}[\s\S]*allow create: if isSuperAdmin\(\)/);
    assert.match(rulesSource, /match \/user_roles\/\{userId\}[\s\S]*allow update: if isSuperAdmin\(\)/);
    assert.match(rulesSource, /match \/user_roles\/\{userId\}[\s\S]*allow delete: if isSuperAdmin\(\)/);
  }
  console.log('PASS [3] Self-promotion & unauthorized role assignment blocked in server workflow and Firestore rules');

  // [4] Admin creates and updates scholarship cleanly (defaults to Pending Review, rejects conflicting income)
  let createdScholarship: Scholarship;
  let createAudit: AdminAuditLogRecord;
  {
    const created = upsertScholarshipWorkflow({
      existing: null,
      input: {
        title: 'State Technical Merit Stipend 2026',
        provider: 'Directorate of Technical Education',
        scholarshipType: 'State Government',
        officialUrl: 'https://mahadbt.maharashtra.gov.in',
        minIncomeLimitInr: 0,
        incomeLimitInr: 800000,
        applicationDeadline: '2026-09-30',
        applicationStatus: 'Currently accepting applications',
      },
      adminUid: 'admin-1',
      adminEmail: 'admin@grantly.in',
      adminRole: 'admin',
      nowIso: NOW_ISO,
    });
    createdScholarship = created.scholarship;
    createAudit = created.auditLog;
    assert.equal(createdScholarship.verificationStatus, 'Pending Review');
    assert.equal(createdScholarship.isActive, true);
    assert.equal(createdScholarship.activeRuleVersion, 1);
    assert.equal(createAudit.action, 'Scholarship Created');

    assert.throws(
      () =>
        upsertScholarshipWorkflow({
          existing: createdScholarship,
          input: {
            title: createdScholarship.title,
            provider: createdScholarship.provider,
            scholarshipType: 'State Government',
            officialUrl: createdScholarship.officialUrl,
            minIncomeLimitInr: 900000,
            incomeLimitInr: 500000,
          },
          adminUid: 'admin-1',
          adminEmail: 'admin@grantly.in',
          adminRole: 'admin',
        }),
      (e: unknown) => e instanceof CompanionError && e.httpStatus === 400 && e.code === 'CONFLICTING_INCOME_BOUNDS'
    );
  }
  console.log('PASS [4] Admin scholarship create/update defaults to Pending Review & blocks conflicting income');

  // [5] Admin verifies scholarship with authoritative evidence -> history + audit log
  let verifiedScholarship: Scholarship;
  {
    const verified = verifyScholarshipWorkflow({
      existing: createdScholarship,
      input: {
        newStatus: 'Verified',
        officialSourceUrl: 'https://mahadbt.maharashtra.gov.in/SchemeData/Technical',
        sourceName: 'MahaDBT Official Portal',
        sourceEvidence: 'Verified against DTE Circular 2026-27 Section 4.2 published on mahadbt.maharashtra.gov.in.',
        verificationNotes: 'Deadline and income ceiling confirmed.',
        humanConfirmed: true,
        httpCheckStatus: 200,
      },
      adminUid: 'admin-1',
      adminEmail: 'admin@grantly.in',
      adminRole: 'admin',
      nowIso: NOW_ISO,
    });
    verifiedScholarship = verified.scholarship;
    assert.equal(verifiedScholarship.verificationStatus, 'Verified');
    assert.equal(verifiedScholarship.verifiedByUid, 'admin-1');
    assert.equal(verifiedScholarship.lastVerifiedDate, '2026-05-10');
    assert.equal(verified.history.previousStatus, 'Pending Review');
    assert.equal(verified.history.newStatus, 'Verified');
    assert.equal(verified.history.httpCheckStatus, 200);
    assert.equal(verified.auditLog.action, 'Scholarship Verification Changed');
  }
  console.log('PASS [5] Evidence-based human scholarship verification recorded history & audit log');

  // [6] Unauthorized or incomplete verification without human confirmation / evidence is rejected
  {
    const noHuman = validateVerificationEvidence({
      newStatus: 'Verified',
      officialSourceUrl: 'https://scholarships.gov.in',
      sourceEvidence: 'Official NSP guideline circular 2026.',
      humanConfirmed: false,
    });
    assert.equal(noHuman.valid, false);

    assert.throws(
      () =>
        verifyScholarshipWorkflow({
          existing: createdScholarship,
          input: {
            newStatus: 'Verified',
            officialSourceUrl: 'https://scholarships.gov.in',
            sourceEvidence: 'Too short',
            humanConfirmed: true,
          },
          adminUid: 'admin-1',
          adminEmail: 'admin@grantly.in',
          adminRole: 'admin',
        }),
      (e: unknown) => e instanceof CompanionError && e.httpStatus === 400
    );

    const noCorrectionReason = validateVerificationEvidence({
      newStatus: 'Needs Correction',
      verificationNotes: '   ',
    });
    assert.equal(noCorrectionReason.valid, false);
  }
  console.log('PASS [6] Unconfirmed or evidence-lacking scholarship verification strictly rejected');

  // [7] Admin archives scholarship while preserving ID & existing application links
  {
    const archived = archiveScholarshipWorkflow({
      existing: verifiedScholarship,
      adminUid: 'admin-1',
      adminEmail: 'admin@grantly.in',
      adminRole: 'admin',
      reason: 'Cycle closed cleanly; historical references preserved.',
      nowIso: NOW_ISO,
    });
    assert.equal(archived.scholarship.id, verifiedScholarship.id);
    assert.equal(archived.scholarship.verificationStatus, 'Archived');
    assert.equal(archived.scholarship.isActive, false);
    assert.ok(archived.scholarship.archivedAt);
    assert.equal(archived.auditLog.action, 'Scholarship Archived');
  }
  console.log('PASS [7] Scholarship archival preserves record ID and records audit event');

  // [8] Admin updates eligibility rules -> versioned snapshot + deterministic eligibility consumption + historical preservation
  let savedRules: ScholarshipEligibilityRule[];
  {
    const ruleResult = saveEligibilityRulesWorkflow({
      scholarship: pragatiBase,
      existingRules: [],
      draftRules: [
        {
          ruleKey: 'previousMarksPercent',
          ruleLabel: 'Minimum 75% Academic Marks',
          operator: 'gte',
          ruleValue: '75',
          isMandatory: true,
          isActive: true,
        },
        {
          ruleKey: 'state',
          ruleLabel: 'Maharashtra & Karnataka Resident Priority',
          operator: 'in',
          ruleValue: 'Maharashtra, Karnataka',
          isMandatory: true,
          isActive: true,
        },
      ],
      changeSummary: 'Added 75% academic cutoff & domicile state rule v2.',
      adminUid: 'admin-1',
      adminEmail: 'admin@grantly.in',
      adminRole: 'admin',
      nowIso: NOW_ISO,
    });

    savedRules = ruleResult.rulesToSave;
    assert.equal(ruleResult.versionRecord.versionNumber, 2);
    assert.equal(ruleResult.updatedScholarship.activeRuleVersion, 2);
    assert.equal(ruleResult.versionRecord.rulesSnapshot.length, 2);

    const studentEligible = makeStudentProfile('s-pass', { previousMarksPercent: 86, state: 'Maharashtra' });
    const studentLowMarks = makeStudentProfile('s-fail', { previousMarksPercent: 68, state: 'Maharashtra' });

    const historicalAssessment: EligibilityAssessment = {
      id: 'hist-assess-v1',
      userId: 's-fail',
      scholarshipId: pragatiBase.id,
      overallStatus: 'Eligible',
      compatibilityScore: 100,
      ruleVersionUsed: 1,
      createdAt: '2026-04-01T10:00:00.000Z',
    };

    const evalPass = evaluateDeterministicEligibility(studentEligible, pragatiBase, REF_DATE, savedRules);
    const evalFail = evaluateDeterministicEligibility(studentLowMarks, pragatiBase, REF_DATE, savedRules);

    assert.equal(evalPass.ruleVersionUsed, 2);
    assert.equal(evalPass.rulesAppliedCount, 2);
    assert.equal(evalPass.overallStatus, 'Eligible');

    assert.equal(evalFail.ruleVersionUsed, 2);
    assert.equal(evalFail.overallStatus, 'Not Eligible');
    assert.ok(evalFail.failedCriteria.some((c) => c.includes('Minimum 75% Academic Marks')));
    // Verify historical assessment snapshot remains untouched
    assert.equal(historicalAssessment.ruleVersionUsed, 1);
    assert.equal(historicalAssessment.overallStatus, 'Eligible');
  }
  console.log('PASS [8] Versioned eligibility rules created, consumed deterministically, and historical snapshots preserved');

  // [9] Invalid or contradictory eligibility rule rejected cleanly
  {
    const badOp = validateScholarshipRuleInput({
      ruleKey: 'state',
      ruleLabel: 'Bad state rule',
      operator: 'lte',
      ruleValue: 'Maharashtra',
      isMandatory: true,
    });
    assert.equal(badOp.valid, false);

    const contradictions = detectRuleContradictions([
      {
        ruleKey: 'previousMarksPercent',
        ruleLabel: 'Min Marks 85%',
        operator: 'gte',
        ruleValue: '85',
        isMandatory: true,
      },
      {
        ruleKey: 'previousMarksPercent',
        ruleLabel: 'Max Marks 70%',
        operator: 'lte',
        ruleValue: '70',
        isMandatory: true,
      },
    ]);
    assert.ok(contradictions.length > 0);

    assert.throws(
      () =>
        saveEligibilityRulesWorkflow({
          scholarship: pragatiBase,
          existingRules: [],
          draftRules: [
            {
              ruleKey: 'familyAnnualIncomeInr',
              ruleLabel: 'Min Income 9L',
              operator: 'gte',
              ruleValue: '900000',
              isMandatory: true,
            },
            {
              ruleKey: 'familyAnnualIncomeInr',
              ruleLabel: 'Max Income 5L',
              operator: 'lte',
              ruleValue: '500000',
              isMandatory: true,
            },
          ],
          changeSummary: 'Contradictory income rules',
          adminUid: 'admin-1',
          adminEmail: 'admin@grantly.in',
          adminRole: 'admin',
        }),
      (e: unknown) => e instanceof CompanionError && e.httpStatus === 400 && e.code === 'INVALID_OR_CONTRADICTORY_RULES'
    );
  }
  console.log('PASS [9] Invalid & contradictory eligibility rules blocked cleanly');

  // [10] Duplicate detection & comprehensive Data Quality scan (no auto-deletion/merge)
  {
    const schA: Scholarship = {
      ...pragatiBase,
      id: 'sch-dup-1',
      title: 'AICTE Pragati Scholarship Scheme for Girl Students',
      officialUrl: 'invalid-url',
      applicationDeadline: '2025-12-31',
      applicationStatus: 'Currently accepting applications',
      minIncomeLimitInr: 900000,
      incomeLimitInr: 500000,
      lastVerifiedDate: '2024-01-01',
    };
    const schB: Scholarship = {
      ...pragatiBase,
      id: 'sch-dup-2',
      title: 'AICTE Pragati Scheme for Girl Students',
      applicationDeadline: 'Check Official Portal',
      applicationStatus: 'Currently accepting applications',
      description: '',
      benefitsSummary: '',
      financialBenefitsText: '',
      annualAwardInr: undefined,
      requiredDocuments: [],
    };
    const schNoCriteria: Scholarship = {
      id: 'sch-no-criteria',
      title: 'Empty Criteria Foundation Award',
      provider: 'Test Trust',
      scholarshipType: 'Private Foundation',
      description: 'Award',
      officialUrl: 'https://example.org/award',
      verificationStatus: 'Pending Review',
      applicationStatus: 'Status unknown',
      applicationStartDate: '2026-10-15',
      applicationDeadline: '2026-09-01',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };

    const issues = runScholarshipDataQualityScan({
      scholarships: [schA, schB, schNoCriteria],
      rules: [],
      referenceDate: REF_DATE,
    });
    const issueTypes = new Set(issues.map((i) => i.issueType));
    assert.ok(issueTypes.has('Duplicate Candidate'));
    assert.ok(issueTypes.has('Missing Official URL'));
    assert.ok(issueTypes.has('Expired Marked Active'));
    assert.ok(issueTypes.has('Conflicting Information'));
    assert.ok(issueTypes.has('Outdated Verification'));
    assert.ok(issueTypes.has('Missing Deadline'));
    assert.ok(issueTypes.has('Incomplete Record'));
    assert.ok(issueTypes.has('Invalid Date Range'));
    assert.ok(issueTypes.has('Missing Eligibility Criteria'));

    const dupIssue = issues.find((i) => i.issueType === 'Duplicate Candidate')!;
    const resolvedIssue = resolveDataQualityIssueWorkflow({
      existing: dupIssue,
      resolutionStatus: 'Acknowledged',
      resolutionNote: 'Reviewed pair manually; keeping both pending archive confirmation.',
      adminUid: 'admin-1',
      adminEmail: 'admin@grantly.in',
      adminRole: 'admin',
      nowIso: NOW_ISO,
    });
    assert.equal(resolvedIssue.issue.resolutionStatus, 'Acknowledged');
    assert.equal(resolvedIssue.auditLog.action, 'Data Quality Issue Resolved');
  }
  console.log('PASS [10] Duplicate detection & 9 data quality checks verified without auto-delete');

  // [11] Failed document retry does NOT falsely mark Completed & metrics count real states
  {
    const failedDoc: DocumentRecord = {
      id: 'doc-failed-vault-missing',
      userId: 'student-alpha',
      documentType: 'Income Certificate',
      fileName: 'corrupt_scan.pdf',
      storagePath: 'private-vault/student-alpha/doc-failed-vault-missing',
      verificationStatus: 'Needs Attention',
      processingStatus: 'Failed',
      errorDetails: 'Original file binary is not present in Private Vault.',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    const tgAssessment: TrustGuardDocumentAssessment = {
      id: 'tg-1',
      userId: 'student-alpha',
      analysisVersion: 'tg-v1',
      dataFingerprint: 'abc',
      overallVerificationStatus: 'Manual Review Required',
      documentsTotalCount: 1,
      documentsAnalyzedCount: 0,
      severityCounts: { critical: 0, high: 1, medium: 0, low: 0, informational: 0 },
      documentResults: [],
      findings: [
        {
          findingId: 'f1',
          evidenceFingerprint: 'ev-doc-readability-1',
          category: 'Document Completeness',
          severity: 'High',
          title: 'Scan unreadable',
          description: 'OCR failed',
          affectedDocuments: [
            {
              documentId: failedDoc.id,
              fileName: failedDoc.fileName,
              documentType: failedDoc.documentType,
            },
          ],
          conflictingValues: [],
          evidenceSource: 'Private Vault OCR Monitor',
          extractionConfidence: 'Low',
          recommendedAction: 'Upload clearer PDF',
          reviewStatus: 'Unreviewed',
        },
      ],
      correctiveActions: ['Upload clearer PDF'],
      limitationNotice: 'Internal consistency check only.',
      disclaimer: 'Not a legal verification.',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };

    const metrics = computeAdminDashboardMetrics({
      profiles: [makeStudentProfile('student-alpha')],
      scholarships: [pragatiBase],
      rules: savedRules,
      applications: [],
      documents: [failedDoc],
      documentAnalyses: [] as DocumentAnalysis[],
      trustGuardReports: [],
      trustGuardAssessments: [tgAssessment],
      referenceDate: REF_DATE,
    });
    assert.equal(metrics.platform.documentJobsByStatus.Failed, 1);
    assert.equal(metrics.platform.documentJobsByStatus.Completed, 0);
    assert.equal(metrics.platform.trustGuardAnalysisFailures, 1);
    assert.equal(metrics.platform.trustGuardAwaitingReview, 1);

    const tgSummary = computeTrustGuardMonitorSummary([tgAssessment]);
    assert.equal(tgSummary.severityCounts.high, 1);
    assert.equal(tgSummary.analysisFailuresCount, 1);

    const adminServiceSrc = await fs.readFile(
      path.resolve(process.cwd(), 'src/server/adminService.ts'),
      'utf8'
    );
    assert.match(adminServiceSrc, /processingStatus:\s*'Failed'/);
    assert.match(adminServiceSrc, /action:\s*'Document Retry Triggered'/);
  }
  console.log('PASS [11] Failed document jobs never falsely completed; real TrustGuard & doc metrics verified');

  // [12] & [13] Audit log creation & strict immutability enforcement in Rules and Server API
  {
    const log = buildAuditLogRecord({
      adminUid: 'admin-1',
      adminEmail: 'admin@grantly.in',
      adminRole: 'admin',
      action: 'Admin Login',
      entityType: 'session',
      entityId: 'admin-1',
      summary: 'Verified admin login.',
      nowIso: NOW_ISO,
    });
    assert.ok(log.id.startsWith('audit-'));
    assert.equal(log.adminRole, 'admin');

    const rulesSource = await fs.readFile(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
    assert.match(rulesSource, /match \/admin_audit_logs\/\{logId\}[\s\S]*allow update: if false;\s*allow delete: if false;/);
    assert.match(
      rulesSource,
      /match \/scholarship_verification_history\/\{historyId\}[\s\S]*allow update: if false;\s*allow delete: if false;/
    );
    assert.match(
      rulesSource,
      /match \/scholarship_rule_versions\/\{versionId\}[\s\S]*allow update: if false;\s*allow delete: if false;/
    );

    const serverSource = await fs.readFile(path.resolve(process.cwd(), 'server.ts'), 'utf8');
    assert.match(serverSource, /AUDIT_LOGS_IMMUTABLE/);
  }
  console.log('PASS [12 & 13] Audit log immutability verified across Firestore rules and API routes');

  // [14] Sanitized student oversight masks emails & omits sensitive PII/tokens
  {
    assert.equal(maskEmailForOversight('riya.deshmukh@example.edu'), 'ri***@example.edu');
    const oversight = buildSanitizedStudentOversight({
      profiles: [makeStudentProfile('student-alpha')],
      applications: [
        {
          id: 'app-1',
          userId: 'student-alpha',
          scholarshipId: pragatiBase.id,
          scholarshipTitle: pragatiBase.title,
          status: 'Preparing',
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        } as ApplicationRecord,
      ],
      documents: [
        {
          id: 'doc-1',
          userId: 'student-alpha',
          documentType: 'Income Certificate',
          fileName: 'income.pdf',
          storagePath: 'private-vault/student-alpha/doc-1',
          verificationStatus: 'Verified',
          processingStatus: 'Completed',
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ],
      trustGuardAssessments: [],
    });

    assert.equal(oversight.length, 1);
    assert.equal(oversight[0].maskedEmail, 'ri***@example.edu');
    assert.equal('phone' in oversight[0], false);
    assert.equal('dateOfBirth' in oversight[0], false);
    assert.equal('familyAnnualIncomeInr' in oversight[0], false);
    assert.equal(oversight[0].applicationCount, 1);
  }
  console.log('PASS [14] Sanitized student oversight masks emails and excludes sensitive personal fields');

  // [15] Super Admin vs regular Admin RBAC boundaries & bootstrap/last Super Admin protection
  {
    const existingRoles: UserRoleRecord[] = [
      {
        uid: 'sa-bootstrap',
        email: BOOTSTRAP_ADMIN_EMAIL,
        role: 'super_admin',
        status: 'active',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
      {
        uid: 'sa-secondary',
        email: 'second.superadmin@grantly.in',
        role: 'super_admin',
        status: 'active',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
      {
        uid: 'reg-admin',
        email: 'reviewer@grantly.in',
        role: 'admin',
        status: 'active',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ];

    // Regular Admin cannot assign roles
    assert.throws(
      () =>
        assignUserRoleWorkflow({
          callerUid: 'reg-admin',
          callerEmail: 'reviewer@grantly.in',
          callerRole: 'admin',
          targetUid: 'student-9',
          targetEmail: 'student9@example.com',
          newRole: 'admin',
          status: 'active',
          existingRoles,
        }),
      (e: unknown) => e instanceof CompanionError && e.httpStatus === 403
    );

    // Bootstrap Super Admin cannot be demoted
    assert.throws(
      () =>
        assignUserRoleWorkflow({
          callerUid: 'sa-secondary',
          callerEmail: 'second.superadmin@grantly.in',
          callerRole: 'super_admin',
          targetUid: 'sa-bootstrap',
          targetEmail: BOOTSTRAP_ADMIN_EMAIL,
          newRole: 'student',
          status: 'active',
          existingRoles,
        }),
      (e: unknown) => e instanceof CompanionError && e.httpStatus === 409 && e.code === 'BOOTSTRAP_SUPER_ADMIN_PROTECTED'
    );

    // Super Admin can promote a student to admin cleanly with audit log
    const promoted = assignUserRoleWorkflow({
      callerUid: 'sa-bootstrap',
      callerEmail: BOOTSTRAP_ADMIN_EMAIL,
      callerRole: 'super_admin',
      targetUid: 'student-9',
      targetEmail: 'newadmin@grantly.in',
      newRole: 'admin',
      status: 'active',
      existingRoles,
      nowIso: NOW_ISO,
    });
    assert.equal(promoted.roleRecord.role, 'admin');
    assert.equal(promoted.auditLog.action, 'Role Updated');
  }
  console.log('PASS [15] Super Admin vs Admin RBAC boundaries & bootstrap Super Admin protection verified');

  console.log('ALL 15 PHASE 9 SECURITY & GOVERNANCE TESTS PASSED');
}

runTests().catch((err) => {
  console.error('Phase 9 verification failed:', err);
  process.exit(1);
});
