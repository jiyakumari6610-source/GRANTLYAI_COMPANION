import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Layers,
  MinusCircle,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import { CircularProgressRing, PageTransition } from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { postProtectedAi } from '../lib/apiClient.ts';
import {
  evaluateDeterministicEligibility,
  type EligibilityEvaluationResult,
} from '../lib/eligibilityEngine.ts';
import { evaluateTrustGuardVerification } from '../lib/trustguardEngine.ts';
import { peekPublicCache, peekUserCache } from '../lib/workspaceCache.ts';
import {
  getDocumentAnalyses,
  getDocuments,
  getEligibilityAssessmentDetails,
  getEligibilityAssessments,
  getScholarshipEligibilityRules,
  getScholarships,
  makeId,
  saveEligibilityAssessmentWithDetails,
  saveProfile,
} from '../lib/firestoreRepo.ts';
import {
  INDIAN_STATES_AND_UTS,
  type CategoryOption,
  type CriterionEvaluationStatus,
  type DisabilityOption,
  type DocumentAnalysis,
  type DocumentRecord,
  type EducationLevelOption,
  type EligibilityAssessment,
  type EligibilityAssessmentDetail,
  type EligibilityOverallStatus,
  type GenderOption,
  type Scholarship,
  type ScholarshipEligibilityRule,
  type StudentProfile,
} from '../types/database.ts';

const EDUCATION_LEVEL_OPTIONS: EducationLevelOption[] = [
  'Class 11-12',
  'Diploma / Polytechnic',
  'Undergraduate (UG)',
  'Postgraduate (PG)',
  'PhD / Doctoral',
];

const CATEGORY_OPTIONS: CategoryOption[] = ['General', 'OBC-NCL', 'SC', 'ST', 'EWS', 'Minority'];
const GENDER_OPTIONS: GenderOption[] = ['Female', 'Male', 'Non-Binary', 'Prefer not to say'];
const DISABILITY_OPTIONS: DisabilityOption[] = [
  'None',
  'PwD (40% or above)',
  'PwD (Below 40%)',
];

type AssessmentStage = 'idle' | 'profile_check' | 'rule_audit' | 'ai_persist';

function getOverallStatusTextClass(status: EligibilityOverallStatus | 'Partially Eligible'): string {
  switch (status) {
    case 'Eligible':
      return 'text-emerald-400';
    case 'Potentially Eligible':
    case 'Partially Eligible':
      return 'text-amber-300';
    case 'Insufficient Information':
      return 'text-slate-200';
    case 'Scholarship Status Unverified':
      return 'text-amber-300';
    case 'Not Eligible':
      return 'text-rose-400';
  }
}

function getCriterionStatusIcon(status: CriterionEvaluationStatus) {
  switch (status) {
    case 'Passed':
      return (
        <span className="text-emerald-400 inline-flex items-center gap-1">
          <CheckCircle2 className="w-4 h-4" /> Passed
        </span>
      );
    case 'Failed':
      return (
        <span className="text-rose-400 inline-flex items-center gap-1">
          <XCircle className="w-4 h-4" /> Failed
        </span>
      );
    case 'Unknown':
      return (
        <span className="text-amber-300 inline-flex items-center gap-1">
          <HelpCircle className="w-4 h-4" /> Unknown
        </span>
      );
    case 'Not Applicable':
      return (
        <span className="text-slate-400 inline-flex items-center gap-1">
          <MinusCircle className="w-4 h-4" /> Not Applicable
        </span>
      );
  }
}

function sanitizeCriterionForFirestore(
  item: EligibilityEvaluationResult['criteriaBreakdown'][number]
) {
  return {
    criterion: item.criterion,
    status: item.status,
    detail: item.detail,
    ...(item.missingFieldKey ? { missingFieldKey: item.missingFieldKey } : {}),
    ...(item.missingFieldReason ? { missingFieldReason: item.missingFieldReason } : {}),
  };
}

export default function EligibilityCheckerPage() {
  const { user, profile, refreshProfile, getIdToken } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedScholarshipId = searchParams.get('scholarshipId');

  const cachedSch = peekPublicCache<{ items: Scholarship[]; isEmptyDatabase: boolean }>('scholarships');
  const cachedRules = peekPublicCache<ScholarshipEligibilityRule[]>('scholarship_eligibility_rules');
  const cachedDocs = peekUserCache<DocumentRecord[]>(user?.uid, 'documents');
  const cachedAnalyses = peekUserCache<DocumentAnalysis[]>(user?.uid, 'document_analysis');
  const cachedHistory = peekUserCache<EligibilityAssessment[]>(
    user?.uid,
    'eligibility_assessments'
  );

  const [scholarships, setScholarships] = useState<Scholarship[]>(() => cachedSch?.items ?? []);
  const [customRules, setCustomRules] = useState<ScholarshipEligibilityRule[]>(
    () => cachedRules ?? []
  );
  const [documents, setDocuments] = useState<DocumentRecord[]>(() => cachedDocs ?? []);
  const [documentAnalyses, setDocumentAnalyses] = useState<DocumentAnalysis[]>(
    () => cachedAnalyses ?? []
  );
  const [selectedId, setSelectedId] = useState<string>(() => {
    const items = cachedSch?.items ?? [];
    if (requestedScholarshipId && items.some((s) => s.id === requestedScholarshipId)) {
      return requestedScholarshipId;
    }
    return items[0]?.id ?? '';
  });
  const [viewMode, setViewMode] = useState<'single' | 'catalogue'>('single');
  const [history, setHistory] = useState<EligibilityAssessment[]>(() => cachedHistory ?? []);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [detailsByAssessmentId, setDetailsByAssessmentId] = useState<
    Record<string, EligibilityAssessmentDetail[]>
  >({});
  const [loadingDetailsId, setLoadingDetailsId] = useState<string | null>(null);

  const [assessmentStage, setAssessmentStage] = useState<AssessmentStage>('idle');
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);
  const [recalculatedNotice, setRecalculatedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inline missing-field quick-complete draft state
  const [missingDraft, setMissingDraft] = useState<{
    familyAnnualIncomeInr: string;
    educationLevel: string;
    courseSpecialization: string;
    previousMarksPercent: string;
    state: string;
    category: string;
    gender: string;
    disabilityStatus: string;
  }>({
    familyAnnualIncomeInr: '',
    educationLevel: '',
    courseSpecialization: '',
    previousMarksPercent: '',
    state: '',
    category: '',
    gender: '',
    disabilityStatus: '',
  });
  const [savingMissing, setSavingMissing] = useState(false);

  const loadWorkspace = useCallback(async () => {
    setError(null);
    const [{ items }, allRules, past, docs, analyses] = await Promise.all([
      getScholarships(),
      getScholarshipEligibilityRules().catch(() => [] as ScholarshipEligibilityRule[]),
      user ? getEligibilityAssessments(user.uid) : Promise.resolve([]),
      user ? getDocuments(user.uid) : Promise.resolve([]),
      user ? getDocumentAnalyses(user.uid) : Promise.resolve([]),
    ]);
    setScholarships(items);
    setCustomRules(allRules);
    setDocuments(docs);
    setDocumentAnalyses(analyses);
    if (requestedScholarshipId && items.some((s) => s.id === requestedScholarshipId)) {
      setSelectedId(requestedScholarshipId);
    } else if (items[0]) {
      setSelectedId((prev) => prev || items[0].id);
    }
    setHistory(past);
  }, [user, requestedScholarshipId]);

  useEffect(() => {
    let active = true;
    loadWorkspace().catch((err) => {
      if (active) {
        setError(err instanceof Error ? err.message : 'Unable to load eligibility workspace.');
      }
    });
    return () => {
      active = false;
    };
  }, [loadWorkspace]);

  const selectedScholarship = useMemo(
    () => scholarships.find((s) => s.id === selectedId) ?? null,
    [scholarships, selectedId]
  );

  const deterministicResult = useMemo(() => {
    if (!selectedScholarship) return null;
    return evaluateDeterministicEligibility(profile, selectedScholarship, new Date(), customRules);
  }, [profile, selectedScholarship, customRules]);

  const trustGuardFindingsForScheme = useMemo(() => {
    if (!user || !selectedScholarship || documents.length === 0) return [];
    const evalRes = evaluateTrustGuardVerification({
      userId: user.uid,
      profile,
      documents,
      documentAnalyses,
      scholarships: [selectedScholarship],
      savedScholarships: [],
      applications: [],
    });
    return evalRes.findings.filter(
      (f) =>
        f.severity === 'Critical' ||
        f.severity === 'High' ||
        f.relatedScholarshipIds?.includes(selectedScholarship.id)
    );
  }, [user, profile, documents, documentAnalyses, selectedScholarship]);

  useEffect(() => {
    setMissingDraft({
      familyAnnualIncomeInr:
        typeof profile?.familyAnnualIncomeInr === 'number'
          ? String(profile.familyAnnualIncomeInr)
          : '',
      educationLevel: profile?.educationLevel ?? '',
      courseSpecialization: profile?.courseSpecialization ?? '',
      previousMarksPercent:
        typeof profile?.previousMarksPercent === 'number'
          ? String(profile.previousMarksPercent)
          : '',
      state: profile?.state ?? '',
      category: profile?.category ?? '',
      gender: profile?.gender ?? '',
      disabilityStatus: profile?.disabilityStatus ?? '',
    });
  }, [profile, selectedId]);

  const catalogueAudit = useMemo(() => {
    const evaluated = scholarships.map((scholarship) => ({
      scholarship,
      result: evaluateDeterministicEligibility(profile, scholarship, new Date(), customRules),
    }));

    return {
      eligible: evaluated
        .filter((x) => x.result.overallStatus === 'Eligible')
        .sort((a, b) => b.result.compatibilityScore - a.result.compatibilityScore),
      potentiallyEligible: evaluated
        .filter((x) => x.result.overallStatus === 'Potentially Eligible')
        .sort((a, b) => b.result.compatibilityScore - a.result.compatibilityScore),
      insufficientInfo: evaluated
        .filter((x) => x.result.overallStatus === 'Insufficient Information')
        .sort((a, b) => b.result.compatibilityScore - a.result.compatibilityScore),
      excluded: evaluated.filter(
        (x) =>
          x.result.overallStatus === 'Not Eligible' ||
          x.result.overallStatus === 'Scholarship Status Unverified'
      ),
    };
  }, [scholarships, profile, customRules]);

  const handleSelectScholarship = (id: string) => {
    setSelectedId(id);
    setAiExplanation(null);
    setRecalculatedNotice(null);
    setError(null);
    setSearchParams(id ? { scholarshipId: id } : {});
  };

  const handleRunAssessment = async () => {
    if (!user || !selectedScholarship) return;
    setError(null);
    setRecalculatedNotice(null);

    try {
      setAssessmentStage('profile_check');
      await new Promise((r) => setTimeout(r, 150));

      setAssessmentStage('rule_audit');
      const freshEval = evaluateDeterministicEligibility(
        profile,
        selectedScholarship,
        new Date(),
        customRules
      );
      await new Promise((r) => setTimeout(r, 150));

      setAssessmentStage('ai_persist');
      const token = await getIdToken();
      const res = await postProtectedAi<{ explanation: string }>(
        '/api/ai/eligibility-explain',
        token,
        {
          scholarship: selectedScholarship,
          profile,
          deterministicResult: {
            overallStatus: freshEval.overallStatus,
            compatibilityScore: freshEval.compatibilityScore,
            scoreFormulaSummary: freshEval.scoreFormulaSummary,
            passedCriteria: freshEval.passedCriteria,
            failedCriteria: freshEval.failedCriteria,
            unknownCriteria: freshEval.unknownCriteria,
            notApplicableCriteria: freshEval.notApplicableCriteria,
            missingProfileFields: freshEval.missingProfileFields.map((m) => ({
              fieldKey: String(m.fieldKey),
              label: m.label,
              reason: m.reason,
            })),
            criteriaBreakdown: freshEval.criteriaBreakdown.map(sanitizeCriterionForFirestore),
          },
        }
      );

      setAiExplanation(res.explanation);

      const now = new Date().toISOString();
      const assessmentId = makeId('elig');
      const cleanBreakdown = freshEval.criteriaBreakdown.map(sanitizeCriterionForFirestore);

      const record: EligibilityAssessment = {
        id: assessmentId,
        userId: user.uid,
        scholarshipId: selectedScholarship.id,
        scholarshipTitle: selectedScholarship.title,
        overallStatus: freshEval.overallStatus,
        compatibilityScore: freshEval.compatibilityScore,
        passedCriteria: freshEval.passedCriteria,
        failedCriteria: freshEval.failedCriteria,
        unknownCriteria: freshEval.unknownCriteria,
        notApplicableCriteria: freshEval.notApplicableCriteria,
        scoreFormulaSummary: freshEval.scoreFormulaSummary,
        criteriaBreakdown: cleanBreakdown,
        aiExplanation: res.explanation,
        ...(typeof freshEval.ruleVersionUsed === 'number'
          ? { ruleVersionUsed: freshEval.ruleVersionUsed }
          : {}),
        ...(typeof freshEval.rulesAppliedCount === 'number'
          ? { rulesAppliedCount: freshEval.rulesAppliedCount }
          : {}),
        createdAt: now,
      };

      const detailRows: EligibilityAssessmentDetail[] = freshEval.criteriaBreakdown.map((c, idx) => ({
        id: `${assessmentId}-d${idx}`,
        assessmentId,
        userId: user.uid,
        scholarshipId: selectedScholarship.id,
        criterion: c.criterion,
        status: c.status,
        detail: c.detail,
        ...(c.missingFieldKey ? { missingFieldKey: String(c.missingFieldKey) } : {}),
        ...(c.missingFieldReason ? { missingFieldReason: c.missingFieldReason } : {}),
        createdAt: now,
      }));

      await saveEligibilityAssessmentWithDetails(record, detailRows);
      setHistory((prev) => [record, ...prev]);
      setDetailsByAssessmentId((prev) => ({ ...prev, [assessmentId]: detailRows }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to complete eligibility audit.');
    } finally {
      setAssessmentStage('idle');
    }
  };

  const handleSaveMissingFieldsAndRecalculate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !deterministicResult) return;

    setSavingMissing(true);
    setError(null);
    setRecalculatedNotice(null);

    try {
      const now = new Date().toISOString();
      const baseProfile: StudentProfile = profile ?? {
        uid: user.uid,
        fullName: user.displayName?.trim() || user.email?.split('@')[0] || 'Student',
        email: user.email ?? '',
        certificates: [],
        onboardingCompleted: false,
        createdAt: now,
        updatedAt: now,
      };

      const nextProfile: StudentProfile = { ...baseProfile, updatedAt: now };

      for (const field of deterministicResult.missingProfileFields) {
        if (field.fieldKey === 'familyAnnualIncomeInr' && missingDraft.familyAnnualIncomeInr !== '') {
          nextProfile.familyAnnualIncomeInr = Number(missingDraft.familyAnnualIncomeInr);
        } else if (field.fieldKey === 'educationLevel' && missingDraft.educationLevel) {
          nextProfile.educationLevel = missingDraft.educationLevel as EducationLevelOption;
        } else if (
          field.fieldKey === 'courseSpecialization' &&
          missingDraft.courseSpecialization.trim()
        ) {
          nextProfile.courseSpecialization = missingDraft.courseSpecialization.trim();
        } else if (
          field.fieldKey === 'previousMarksPercent' &&
          missingDraft.previousMarksPercent !== ''
        ) {
          nextProfile.previousMarksPercent = Number(missingDraft.previousMarksPercent);
        } else if (field.fieldKey === 'state' && missingDraft.state) {
          nextProfile.state = missingDraft.state;
        } else if (field.fieldKey === 'category' && missingDraft.category) {
          nextProfile.category = missingDraft.category as CategoryOption;
        } else if (field.fieldKey === 'gender' && missingDraft.gender) {
          nextProfile.gender = missingDraft.gender as GenderOption;
        } else if (field.fieldKey === 'disabilityStatus' && missingDraft.disabilityStatus) {
          nextProfile.disabilityStatus = missingDraft.disabilityStatus as DisabilityOption;
        }
      }

      await saveProfile(nextProfile);
      await refreshProfile();
      setAiExplanation(null);
      setRecalculatedNotice(
        'Missing profile fields saved to your account. Eligibility criteria and compatibility score have been recalculated.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save missing profile fields.');
    } finally {
      setSavingMissing(false);
    }
  };

  const handleToggleHistoryDetails = async (assessmentId: string) => {
    if (expandedHistoryId === assessmentId) {
      setExpandedHistoryId(null);
      return;
    }
    setExpandedHistoryId(assessmentId);
    if (!user || detailsByAssessmentId[assessmentId]) return;

    setLoadingDetailsId(assessmentId);
    try {
      const rows = await getEligibilityAssessmentDetails(user.uid, assessmentId);
      setDetailsByAssessmentId((prev) => ({ ...prev, [assessmentId]: rows }));
    } catch {
      // Fallback to criteriaBreakdown stored on parent assessment if details query fails
    } finally {
      setLoadingDetailsId(null);
    }
  };

  const isAssessing = assessmentStage !== 'idle';

  return (
    <AppShell
      title="Eligibility Engine"
      breadcrumb="Workspace / Deterministic Scholarship Eligibility"
      primaryAction={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewMode('single')}
            className={`px-3.5 py-2 text-xs font-semibold rounded-xl border whitespace-nowrap transition-colors ${
              viewMode === 'single'
                ? 'bg-indigo-600 text-white border-indigo-500'
                : 'bg-slate-900/80 text-slate-300 border-slate-700 hover:bg-slate-800'
            }`}
          >
            Single Audit
          </button>
          <button
            type="button"
            onClick={() => setViewMode('catalogue')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl border whitespace-nowrap transition-colors ${
              viewMode === 'catalogue'
                ? 'bg-indigo-600 text-white border-indigo-500'
                : 'bg-slate-900/80 text-slate-300 border-slate-700 hover:bg-slate-800'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Match All ({scholarships.length})</span>
          </button>
        </div>
      }
    >
      <PageTransition className="space-y-6">
        {viewMode === 'catalogue' ? (
          <div className="space-y-6">
            {/* Catalogue-Wide Eligibility Summary */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="surface-card rounded-2xl p-5">
                <p className="text-xs font-medium text-slate-400">Eligible Schemes</p>
                <p className="text-2xl font-bold text-emerald-400 font-mono-num mt-1.5">
                  {catalogueAudit.eligible.length}
                </p>
              </div>
              <div className="surface-card rounded-2xl p-5">
                <p className="text-xs font-medium text-slate-400">Potentially Eligible</p>
                <p className="text-2xl font-bold text-amber-300 font-mono-num mt-1.5">
                  {catalogueAudit.potentiallyEligible.length}
                </p>
              </div>
              <div className="surface-card rounded-2xl p-5">
                <p className="text-xs font-medium text-slate-400">Insufficient Information</p>
                <p className="text-2xl font-bold text-slate-200 font-mono-num mt-1.5">
                  {catalogueAudit.insufficientInfo.length}
                </p>
              </div>
              <div className="surface-card rounded-2xl p-5">
                <p className="text-xs font-medium text-slate-400">Excluded (Ineligible / Unverified)</p>
                <p className="text-2xl font-bold text-rose-400 font-mono-num mt-1.5">
                  {catalogueAudit.excluded.length}
                </p>
              </div>
            </div>

            {[
              {
                title: 'Eligible Scholarships',
                subtitle: 'All applicable deterministic criteria passed against your profile.',
                rows: catalogueAudit.eligible,
                emptyMsg: 'No scholarships currently pass 100% of applicable rules.',
              },
              {
                title: 'Potentially Eligible Scholarships',
                subtitle: 'No rules failed, but 1 or more missing profile fields must be confirmed.',
                rows: catalogueAudit.potentiallyEligible,
                emptyMsg: 'No potentially eligible schemes pending partial information.',
              },
              {
                title: 'Insufficient Information',
                subtitle: 'Multiple required academic, income, or demographic profile fields are missing.',
                rows: catalogueAudit.insufficientInfo,
                emptyMsg: 'No schemes blocked primarily by missing information.',
              },
              {
                title: 'Excluded (Not Eligible, Expired, or Unverified)',
                subtitle: 'Automatically excluded from eligible recommendations.',
                rows: catalogueAudit.excluded,
                emptyMsg: 'No excluded schemes.',
              },
            ].map((section) => (
              <div key={section.title} className="surface-card rounded-2xl p-6 space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-white font-display">{section.title}</h2>
                  <p className="text-xs text-slate-400">{section.subtitle}</p>
                </div>
                {section.rows.length === 0 ? (
                  <p className="text-xs text-slate-400">{section.emptyMsg}</p>
                ) : (
                  <div className="divide-y divide-slate-800/80">
                    {section.rows.map(({ scholarship, result }) => (
                      <div
                        key={scholarship.id}
                        className="py-3.5 first:pt-1 last:pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="space-y-1 min-w-0">
                          <p className="text-sm font-semibold text-white truncate">
                            {scholarship.title}
                          </p>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                            <span className={`font-semibold ${getOverallStatusTextClass(result.overallStatus)}`}>
                              {result.overallStatus}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono-num">
                              Compatibility: {result.compatibilityScore}%
                            </span>
                            {result.failedCriteria.length > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-rose-400">
                                  Failed: {result.failedCriteria.join(', ')}
                                </span>
                              </>
                            )}
                            {result.unknownCriteria.length > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-amber-300">
                                  Unknown: {result.unknownCriteria.join(', ')}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            handleSelectScholarship(scholarship.id);
                            setViewMode('single');
                          }}
                          className="px-3.5 py-2 text-xs font-semibold text-indigo-200 bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/30 rounded-xl whitespace-nowrap shrink-0"
                        >
                          Inspect Audit
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* Selector & Action Bar */}
            <div className="surface-card rounded-2xl p-6 space-y-4">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                <div className="flex-1 space-y-1.5">
                  <label htmlFor="elig-select" className="block text-xs font-medium text-slate-300">
                    Select Scholarship to Audit
                  </label>
                  <select
                    id="elig-select"
                    value={selectedId}
                    disabled={scholarships.length === 0}
                    onChange={(e) => handleSelectScholarship(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight disabled:opacity-60"
                  >
                    {scholarships.length === 0 ? (
                      <option value="">No scholarships published in database yet</option>
                    ) : (
                      scholarships.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <button
                  type="button"
                  onClick={handleRunAssessment}
                  disabled={isAssessing || !selectedScholarship}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold btn-primary-gradient rounded-xl disabled:opacity-60 whitespace-nowrap"
                >
                  {aiExplanation ? (
                    <RefreshCw className={`w-4 h-4 ${isAssessing ? 'animate-spin' : ''}`} />
                  ) : (
                    <Sparkles className="w-4 h-4" />
                  )}
                  <span>
                    {isAssessing
                      ? 'Evaluating Eligibility...'
                      : aiExplanation
                        ? 'Reassess Eligibility & Save'
                        : 'Check Eligibility & Explain'}
                  </span>
                </button>
              </div>

              {/* Multi-stage progress indicator */}
              {isAssessing && (
                <div className="p-3.5 rounded-xl bg-slate-900/80 border border-indigo-500/30 grid sm:grid-cols-3 gap-3 text-xs">
                  {[
                    { key: 'profile_check', label: '1. Inspecting profile & scheme rules' },
                    { key: 'rule_audit', label: '2. Computing deterministic score' },
                    { key: 'ai_persist', label: '3. Generating explanation & saving' },
                  ].map((st) => {
                    const order = ['profile_check', 'rule_audit', 'ai_persist'];
                    const activeIdx = order.indexOf(assessmentStage);
                    const thisIdx = order.indexOf(st.key);
                    const done = thisIdx < activeIdx;
                    const current = thisIdx === activeIdx;
                    return (
                      <div
                        key={st.key}
                        className={`flex items-center gap-2 font-medium ${
                          done ? 'text-emerald-400' : current ? 'text-indigo-300' : 'text-slate-500'
                        }`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span>{st.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {recalculatedNotice && (
                <div className="p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-xs sm:text-sm text-emerald-200 flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
                  <span>{recalculatedNotice}</span>
                </div>
              )}

              {error && (
                <div className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-sm text-rose-200 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                    <span>{error}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadWorkspace()}
                    className="px-3 py-1.5 text-xs font-semibold text-rose-100 bg-rose-500/25 hover:bg-rose-500/35 border border-rose-400/30 rounded-lg whitespace-nowrap"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>

            {deterministicResult && selectedScholarship && (
              <div className="grid lg:grid-cols-12 gap-6">
                {/* Left 7 Cols: Result Card + Formula Breakdown + Rule-by-Rule Evaluation */}
                <div className="lg:col-span-7 space-y-6">
                  <div className="surface-elevated rounded-2xl p-6 space-y-5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
                      <div>
                        <p className="text-xs font-medium text-slate-400">
                          Deterministic Eligibility Classification
                        </p>
                        <p
                          className={`text-xl font-bold font-display mt-1 ${getOverallStatusTextClass(
                            deterministicResult.overallStatus
                          )}`}
                        >
                          {deterministicResult.overallStatus}
                        </p>
                        {typeof deterministicResult.ruleVersionUsed === 'number' && (
                          <p className="text-[11px] font-mono-num text-slate-400 mt-1">
                            Rule Version v{deterministicResult.ruleVersionUsed} ({deterministicResult.rulesAppliedCount ?? 0} custom rules)
                          </p>
                        )}
                      </div>
                      <CircularProgressRing
                        percent={deterministicResult.compatibilityScore}
                        size={84}
                        strokeWidth={7}
                        sublabel="Match"
                        tone={
                          deterministicResult.overallStatus === 'Eligible'
                            ? 'emerald'
                            : deterministicResult.overallStatus === 'Potentially Eligible'
                              ? 'amber'
                              : deterministicResult.overallStatus === 'Not Eligible'
                                ? 'rose'
                                : 'indigo'
                        }
                      />
                    </div>

                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          deterministicResult.overallStatus === 'Eligible'
                            ? 'bg-emerald-500'
                            : deterministicResult.overallStatus === 'Potentially Eligible'
                              ? 'bg-amber-400'
                              : deterministicResult.overallStatus === 'Not Eligible'
                                ? 'bg-rose-500'
                                : 'bg-indigo-400'
                        }`}
                        style={{ width: `${deterministicResult.compatibilityScore}%` }}
                      />
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center text-xs pt-1">
                      <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                        <p className="text-slate-400">Passed</p>
                        <p className="font-bold text-emerald-400 font-mono-num text-base mt-0.5">
                          {deterministicResult.passedCriteria.length}
                        </p>
                      </div>
                      <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                        <p className="text-slate-400">Failed</p>
                        <p className="font-bold text-rose-400 font-mono-num text-base mt-0.5">
                          {deterministicResult.failedCriteria.length}
                        </p>
                      </div>
                      <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                        <p className="text-slate-400">Unknown</p>
                        <p className="font-bold text-amber-300 font-mono-num text-base mt-0.5">
                          {deterministicResult.unknownCriteria.length}
                        </p>
                      </div>
                      <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                        <p className="text-slate-400">Not Applicable</p>
                        <p className="font-bold text-slate-300 font-mono-num text-base mt-0.5">
                          {deterministicResult.notApplicableCriteria.length}
                        </p>
                      </div>
                    </div>

                    <p className="text-xs text-slate-300 leading-relaxed bg-slate-900/70 border border-slate-800 rounded-xl p-3.5">
                      {deterministicResult.scoreFormulaSummary}
                    </p>

                    {deterministicResult.overallStatus === 'Scholarship Status Unverified' && (
                      <div className="p-3.5 rounded-xl bg-amber-500/12 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2">
                        <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-300" />
                        <span>
                          This scholarship&rsquo;s official verification status is currently{' '}
                          <strong>{selectedScholarship.verificationStatus}</strong>. Confirm the rules on the official portal before relying on this evaluation.
                        </span>
                      </div>
                    )}

                    {trustGuardFindingsForScheme.length > 0 && (
                      <div className="p-3.5 rounded-xl bg-amber-500/12 border border-amber-500/30 text-xs text-amber-100 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 font-semibold text-amber-200">
                            <ShieldAlert className="w-4 h-4 text-amber-300" />
                            TrustGuard Document Consistency Watch ({trustGuardFindingsForScheme.length})
                          </span>
                          <Link
                            to="/trustguard"
                            className="font-semibold text-indigo-300 hover:underline shrink-0"
                          >
                            Inspect in TrustGuard
                          </Link>
                        </div>
                        <ul className="space-y-1 text-amber-200/90">
                          {trustGuardFindingsForScheme.slice(0, 3).map((f) => (
                            <li key={f.findingId}>
                              <span className="font-semibold">{f.severity}:</span> {f.title}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* Missing Profile Fields Inline Completion */}
                  {deterministicResult.missingProfileFields.length > 0 && (
                    <form
                      onSubmit={handleSaveMissingFieldsAndRecalculate}
                      className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-6 space-y-4"
                    >
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
                        <div>
                          <h2 className="text-sm font-semibold text-amber-100 font-display">
                            Missing Profile Information Required ({deterministicResult.missingProfileFields.length})
                          </h2>
                          <p className="text-xs text-amber-200/80 mt-0.5">
                            Only fields currently missing from your profile and required by this scheme are requested below.
                          </p>
                        </div>
                      </div>

                      <div className="grid sm:grid-cols-2 gap-3.5">
                        {deterministicResult.missingProfileFields.map((field) => (
                          <div key={String(field.fieldKey)} className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-3.5 space-y-1.5">
                            <label className="block text-xs font-semibold text-slate-100">
                              {field.label}
                            </label>
                            <p className="text-[11px] text-slate-400">{field.reason}</p>

                            {field.fieldKey === 'familyAnnualIncomeInr' && (
                              <input
                                type="number"
                                min="0"
                                required
                                value={missingDraft.familyAnnualIncomeInr}
                                onChange={(e) =>
                                  setMissingDraft((d) => ({ ...d, familyAnnualIncomeInr: e.target.value }))
                                }
                                placeholder="e.g. 180000"
                                className="w-full px-3 py-2 text-xs rounded-lg input-midnight font-mono-num"
                              />
                            )}

                            {field.fieldKey === 'previousMarksPercent' && (
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="0.1"
                                required
                                value={missingDraft.previousMarksPercent}
                                onChange={(e) =>
                                  setMissingDraft((d) => ({ ...d, previousMarksPercent: e.target.value }))
                                }
                                placeholder="e.g. 82.5"
                                className="w-full px-3 py-2 text-xs rounded-lg input-midnight font-mono-num"
                              />
                            )}

                            {field.fieldKey === 'courseSpecialization' && (
                              <input
                                type="text"
                                required
                                value={missingDraft.courseSpecialization}
                                onChange={(e) =>
                                  setMissingDraft((d) => ({ ...d, courseSpecialization: e.target.value }))
                                }
                                placeholder="e.g. B.Tech CSE, B.Sc Physics"
                                className="w-full px-3 py-2 text-xs rounded-lg input-midnight"
                              />
                            )}

                            {field.fieldKey === 'educationLevel' && (
                              <select
                                required
                                value={missingDraft.educationLevel}
                                onChange={(e) =>
                                  setMissingDraft((d) => ({ ...d, educationLevel: e.target.value }))
                                }
                                className="w-full px-3 py-2 text-xs rounded-lg input-midnight"
                              >
                                <option value="">Select education level</option>
                                {EDUCATION_LEVEL_OPTIONS.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                              </select>
                            )}

                            {field.fieldKey === 'state' && (
                              <select
                                required
                                value={missingDraft.state}
                                onChange={(e) =>
                                  setMissingDraft((d) => ({ ...d, state: e.target.value }))
                                }
                                className="w-full px-3 py-2 text-xs rounded-lg input-midnight"
                              >
                                <option value="">Select domicile state / UT</option>
                                {INDIAN_STATES_AND_UTS.map((st) => (
                                  <option key={st} value={st}>
                                    {st}
                                  </option>
                                ))}
                              </select>
                            )}

                            {field.fieldKey === 'category' && (
                              <select
                                required
                                value={missingDraft.category}
                                onChange={(e) =>
                                  setMissingDraft((d) => ({ ...d, category: e.target.value }))
                                }
                                className="w-full px-3 py-2 text-xs rounded-lg input-midnight"
                              >
                                <option value="">Select social category</option>
                                {CATEGORY_OPTIONS.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            )}

                            {field.fieldKey === 'gender' && (
                              <select
                                required
                                value={missingDraft.gender}
                                onChange={(e) =>
                                  setMissingDraft((d) => ({ ...d, gender: e.target.value }))
                                }
                                className="w-full px-3 py-2 text-xs rounded-lg input-midnight"
                              >
                                <option value="">Select gender</option>
                                {GENDER_OPTIONS.map((g) => (
                                  <option key={g} value={g}>
                                    {g}
                                  </option>
                                ))}
                              </select>
                            )}

                            {field.fieldKey === 'disabilityStatus' && (
                              <select
                                required
                                value={missingDraft.disabilityStatus}
                                onChange={(e) =>
                                  setMissingDraft((d) => ({ ...d, disabilityStatus: e.target.value }))
                                }
                                className="w-full px-3 py-2 text-xs rounded-lg input-midnight"
                              >
                                <option value="">Select disability status</option>
                                {DISABILITY_OPTIONS.map((d) => (
                                  <option key={d} value={d}>
                                    {d}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                        <Link
                          to="/profile"
                          className="text-xs font-medium text-amber-200 hover:underline"
                        >
                          Open full profile settings →
                        </Link>
                        <button
                          type="submit"
                          disabled={savingMissing}
                          className="px-4 py-2 text-xs font-semibold btn-primary-gradient rounded-xl disabled:opacity-60 whitespace-nowrap"
                        >
                          {savingMissing ? 'Saving & Recalculating...' : 'Save Missing Info & Recalculate'}
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Rule-by-Rule Evaluation Breakdown */}
                  <div className="surface-card rounded-2xl p-6 space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                      <h2 className="text-base font-semibold text-white font-display">
                        Rule-by-Rule Criteria Breakdown
                      </h2>
                      <Link
                        to={`/scholarships/${selectedScholarship.id}`}
                        className="text-xs font-semibold text-indigo-300 hover:underline"
                      >
                        View full scheme →
                      </Link>
                    </div>

                    <div className="space-y-2.5">
                      {deterministicResult.criteriaBreakdown.map((item) => (
                        <div
                          key={item.criterion}
                          className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 flex items-start justify-between gap-4"
                        >
                          <div className="space-y-1">
                            <p className="text-sm font-semibold text-white">{item.criterion}</p>
                            <p className="text-xs text-slate-400 leading-relaxed">{item.detail}</p>
                          </div>
                          <div className="shrink-0 text-xs font-semibold">
                            {getCriterionStatusIcon(item.status)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Right 5 Cols: Gemini Grounded Explanation + Persisted Audit History & Details */}
                <div className="lg:col-span-5 space-y-6">
                  <div className="surface-card rounded-2xl p-6 space-y-3">
                    <div className="flex items-center justify-between">
                      <h2 className="text-base font-semibold text-white font-display">
                        Explainable AI Analysis
                      </h2>
                      <span className="text-[11px] font-medium text-indigo-300">
                        Grounded in deterministic rules
                      </span>
                    </div>
                    {aiExplanation ? (
                      <p className="text-sm text-slate-300 whitespace-pre-line leading-relaxed">
                        {aiExplanation}
                      </p>
                    ) : (
                      <p className="text-sm text-slate-400 leading-relaxed">
                        Click &ldquo;Check Eligibility &amp; Explain&rdquo; to generate a student-friendly Gemini summary of your passed, failed, and unknown criteria and save the audit record to your account.
                      </p>
                    )}
                  </div>

                  {history.length > 0 && (
                    <div className="surface-card rounded-2xl p-6 space-y-3">
                      <h3 className="text-sm font-semibold text-white font-display">
                        Saved Eligibility Audits ({history.length})
                      </h3>
                      <div className="divide-y divide-slate-800/80">
                        {history.slice(0, 8).map((h) => {
                          const isExpanded = expandedHistoryId === h.id;
                          const detailRows = detailsByAssessmentId[h.id] ?? [];
                          return (
                            <div key={h.id} className="py-3 text-xs space-y-2">
                              <button
                                type="button"
                                onClick={() => void handleToggleHistoryDetails(h.id)}
                                className="w-full text-left flex items-start justify-between gap-2"
                              >
                                <div className="min-w-0 space-y-0.5">
                                  <p className="font-semibold text-slate-100 truncate">
                                    {h.scholarshipTitle || h.scholarshipId}
                                  </p>
                                  <p className="text-slate-400 font-mono-num">
                                    {new Date(h.createdAt).toLocaleString('en-IN')}
                                    {typeof h.compatibilityScore === 'number'
                                      ? ` · Score ${h.compatibilityScore}%`
                                      : ''}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span
                                    className={`font-semibold ${getOverallStatusTextClass(
                                      h.overallStatus
                                    )}`}
                                  >
                                    {h.overallStatus}
                                  </span>
                                  {isExpanded ? (
                                    <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                                  ) : (
                                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                                  )}
                                </div>
                              </button>

                              {isExpanded && (
                                <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800 space-y-2">
                                  {loadingDetailsId === h.id ? (
                                    <p className="text-slate-400">Loading saved criterion details...</p>
                                  ) : (
                                    <>
                                      {(detailRows.length > 0
                                        ? detailRows
                                        : h.criteriaBreakdown ?? []
                                      ).map((row, idx) => (
                                        <div
                                          key={`${h.id}-${idx}`}
                                          className="flex items-start justify-between gap-2 border-b border-slate-800 last:border-0 pb-1.5 last:pb-0"
                                        >
                                          <span className="font-medium text-slate-200">
                                            {row.criterion}
                                          </span>
                                          <span className="text-slate-300 shrink-0 font-semibold">
                                            {row.status}
                                          </span>
                                        </div>
                                      ))}
                                      {h.aiExplanation && (
                                        <p className="text-[11px] text-slate-400 whitespace-pre-line pt-1 border-t border-slate-800">
                                          {h.aiExplanation}
                                        </p>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </PageTransition>
    </AppShell>
  );
}
