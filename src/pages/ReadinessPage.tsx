import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileWarning,
  MessageSquareText,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import {
  AnimatedCounter,
  CircularProgressRing,
  PageTransition,
  SkeletonCard,
  StaggerGrid,
  StaggerItem,
} from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { postProtectedAi } from '../lib/apiClient.ts';
import {
  getApplications,
  getDocumentAnalyses,
  getDocuments,
  getEligibilityAssessments,
  getReadinessAssessments,
  getSavedScholarships,
  getScholarships,
  makeId,
  saveReadinessAssessment,
  updateReadinessAssessmentActions,
} from '../lib/firestoreRepo.ts';
import {
  evaluateScholarshipReadiness,
  type ReadinessEvaluationReport,
} from '../lib/readinessEngine.ts';
import type {
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  EligibilityAssessment,
  ReadinessActionItem,
  ReadinessActionStatus,
  ReadinessAssessment,
  SavedScholarship,
  Scholarship,
  ScholarshipSpecificReadiness,
} from '../types/database.ts';

type ActionFilter = 'All' | ReadinessActionStatus;
type SchemeFilter = 'All' | 'Eligible & Potential' | 'Saved & Tracked' | 'Not Eligible';

const READINESS_COMPANION_PROMPTS = [
  'Why is my readiness score low?',
  'How can I improve my readiness score?',
  'Which documents should I upload first?',
  'Which scholarship am I closest to being ready for?',
  'What should I complete this week?',
  'Why is my readiness assessment incomplete?',
] as const;

interface AssessApiResponse {
  report: ReadinessEvaluationReport;
  aiActionPlan?: string;
  aiReusedFromCache?: boolean;
}

function getStatusTextClass(status: string): string {
  switch (status) {
    case 'Ready':
    case 'Strong':
    case 'Application Ready':
    case 'Eligible':
      return 'text-emerald-300';
    case 'Partially Ready':
    case 'Moderate':
    case 'Nearly Ready':
    case 'Potentially Eligible':
    case 'In Progress':
      return 'text-amber-300';
    case 'Needs Preparation':
    case 'Needs Attention':
    case 'Preparation Needed':
    case 'Incomplete':
    case 'Not Eligible':
      return 'text-rose-300';
    case 'Assessment Incomplete':
    case 'No Scholarship Data':
    case 'Blocked — Missing Info':
    case 'Insufficient Information':
    case 'Status Unverified':
    case 'Scholarship Status Unverified':
    case 'Unavailable':
      return 'text-slate-400';
    default:
      return 'text-slate-300';
  }
}

function getProgressBarColor(scorePercent: number | null, overallStatus?: string): string {
  if (scorePercent === null || overallStatus === 'Assessment Incomplete' || overallStatus === 'No Scholarship Data') {
    return 'bg-slate-600';
  }
  if (scorePercent >= 80) return 'bg-emerald-500';
  if (scorePercent >= 55) return 'bg-amber-500';
  return 'bg-rose-500';
}

function getRingTone(scorePercent: number | null): 'indigo' | 'emerald' | 'amber' | 'rose' {
  if (scorePercent === null) return 'indigo';
  if (scorePercent >= 80) return 'emerald';
  if (scorePercent >= 55) return 'amber';
  return 'rose';
}

export default function ReadinessPage() {
  const { user, profile, getIdToken } = useAuth();

  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [documentAnalyses, setDocumentAnalyses] = useState<DocumentAnalysis[]>([]);
  const [eligibilityAssessments, setEligibilityAssessments] = useState<EligibilityAssessment[]>([]);
  const [savedScholarships, setSavedScholarships] = useState<SavedScholarship[]>([]);
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [scholarships, setScholarships] = useState<Scholarship[]>([]);
  const [assessments, setAssessments] = useState<ReadinessAssessment[]>([]);

  const [serverReport, setServerReport] = useState<ReadinessEvaluationReport | null>(null);
  const [actionItems, setActionItems] = useState<ReadinessActionItem[]>([]);
  const [aiActionPlan, setAiActionPlan] = useState<string | null>(null);
  const [aiReusedFromCache, setAiReusedFromCache] = useState(false);

  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [generatingAi, setGeneratingAi] = useState(false);
  const [savingActionId, setSavingActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<ActionFilter>('All');
  const [schemeFilter, setSchemeFilter] = useState<SchemeFilter>('All');
  const [expandedDimension, setExpandedDimension] = useState<string | null>(null);
  const [showCompletedList, setShowCompletedList] = useState(false);

  const persistedFingerprintsRef = useRef<Set<string>>(new Set());

  const persistSnapshot = useCallback(
    async (
      uid: string,
      evalReport: ReadinessEvaluationReport,
      planText?: string,
      actionsOverride?: ReadinessActionItem[]
    ) => {
      const now = new Date().toISOString();
      const record: ReadinessAssessment = {
        id: makeId('rdy'),
        userId: uid,
        readinessPercent: evalReport.readinessPercent,
        overallScore: evalReport.overallScore,
        assessmentStatus: evalReport.assessmentStatus,
        algorithmVersion: evalReport.algorithmVersion,
        dataFingerprint: evalReport.dataFingerprint,
        dataAvailabilityWarning: evalReport.dataAvailabilityWarning,
        disclaimer: evalReport.disclaimer,
        profileCompletenessPercent: evalReport.profileCompletenessPercent,
        documentCoveragePercent: evalReport.documentCoveragePercent,
        dimensionScores: evalReport.dimensionScores,
        completedRequirements: evalReport.completedRequirements,
        incompleteRequirements: evalReport.incompleteRequirements,
        deductionReasons: evalReport.deductionReasons,
        missingItems: [
          ...evalReport.missingProfileFields.map((f) => `Missing profile: ${f}`),
          ...evalReport.missingDocuments.map((d) => `Missing document: ${d}`),
          ...evalReport.flaggedDocuments.map((d) => `Review document: ${d}`),
        ],
        scholarshipReadiness: evalReport.scholarshipReadiness,
        recommendedActions: actionsOverride ?? evalReport.recommendedActions,
        aiActionPlan: planText,
        createdAt: now,
        updatedAt: now,
      };
      await saveReadinessAssessment(record);
      persistedFingerprintsRef.current.add(evalReport.dataFingerprint);
      setAssessments((prev) => [record, ...prev]);
      return record;
    },
    []
  );

  const runServerAssessment = useCallback(
    async (params: {
      uid: string;
      docsRes: DocumentRecord[];
      anaRes: DocumentAnalysis[];
      eligRes: EligibilityAssessment[];
      savedRes: SavedScholarship[];
      appsRes: ApplicationRecord[];
      latestSaved: ReadinessAssessment | null;
      includeAiExplanation: boolean;
      persistIfChanged: boolean;
    }) => {
      const {
        uid,
        docsRes,
        anaRes,
        eligRes,
        savedRes,
        appsRes,
        latestSaved,
        includeAiExplanation,
        persistIfChanged,
      } = params;

      const token = await getIdToken();
      const res = await postProtectedAi<AssessApiResponse>('/api/readiness/assess', token, {
        studentContext: {
          profile,
          documents: docsRes,
          documentAnalyses: anaRes,
          eligibilityAssessments: eligRes,
          savedScholarships: savedRes,
          applications: appsRes,
          readinessAssessments: latestSaved ? [latestSaved] : [],
        },
        previousActions: latestSaved?.recommendedActions ?? [],
        includeAiExplanation,
        cachedAssessment: latestSaved
          ? {
              dataFingerprint: latestSaved.dataFingerprint,
              aiActionPlan: latestSaved.aiActionPlan,
            }
          : null,
      });

      setServerReport(res.report);
      setActionItems(res.report.recommendedActions);

      const resolvedPlan = res.aiActionPlan ?? latestSaved?.aiActionPlan ?? null;
      if (res.aiActionPlan) {
        setAiActionPlan(res.aiActionPlan);
        setAiReusedFromCache(Boolean(res.aiReusedFromCache));
      } else if (latestSaved?.dataFingerprint === res.report.dataFingerprint && latestSaved.aiActionPlan) {
        setAiActionPlan(latestSaved.aiActionPlan);
        setAiReusedFromCache(true);
      }

      const fingerprintChanged = latestSaved?.dataFingerprint !== res.report.dataFingerprint;
      if (
        persistIfChanged &&
        (fingerprintChanged || (includeAiExplanation && res.aiActionPlan && !res.aiReusedFromCache))
      ) {
        if (!latestSaved || fingerprintChanged) {
          if (!persistedFingerprintsRef.current.has(res.report.dataFingerprint)) {
            await persistSnapshot(uid, res.report, resolvedPlan ?? undefined, res.report.recommendedActions);
          }
        } else if (includeAiExplanation && res.aiActionPlan && latestSaved) {
          await updateReadinessAssessmentActions(latestSaved.id, {
            recommendedActions: res.report.recommendedActions,
            aiActionPlan: res.aiActionPlan,
            updatedAt: new Date().toISOString(),
          });
          setAssessments((prev) =>
            prev.map((a) =>
              a.id === latestSaved.id
                ? { ...a, aiActionPlan: res.aiActionPlan, updatedAt: new Date().toISOString() }
                : a
            )
          );
        }
      }

      return res;
    },
    [getIdToken, persistSnapshot, profile]
  );

  useEffect(() => {
    if (!user) return;
    let active = true;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [docsRes, anaRes, eligRes, savedRes, appsRes, schRes, assessRes] = await Promise.all([
          getDocuments(user.uid),
          getDocumentAnalyses(user.uid),
          getEligibilityAssessments(user.uid),
          getSavedScholarships(user.uid),
          getApplications(user.uid),
          getScholarships(),
          getReadinessAssessments(user.uid),
        ]);
        if (!active) return;

        setDocuments(docsRes);
        setDocumentAnalyses(anaRes);
        setEligibilityAssessments(eligRes);
        setSavedScholarships(savedRes);
        setApplications(appsRes);
        setScholarships(schRes.items);
        setAssessments(assessRes);

        const latestSaved = assessRes[0] ?? null;
        if (latestSaved?.dataFingerprint) {
          persistedFingerprintsRef.current.add(latestSaved.dataFingerprint);
        }
        if (latestSaved?.aiActionPlan) {
          setAiActionPlan(latestSaved.aiActionPlan);
        }

        try {
          await runServerAssessment({
            uid: user.uid,
            docsRes,
            anaRes,
            eligRes,
            savedRes,
            appsRes,
            latestSaved,
            includeAiExplanation: false,
            persistIfChanged: true,
          });
        } catch (serverErr) {
          if (active) {
            setError(
              serverErr instanceof Error
                ? `Server readiness refresh note: ${serverErr.message}. Showing deterministic local evaluation.`
                : 'Showing deterministic local evaluation.'
            );
          }
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load readiness data.');
        }
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [user, runServerAssessment]);

  const latestSaved = assessments[0] ?? null;

  const liveReport = useMemo(
    () =>
      evaluateScholarshipReadiness({
        profile,
        documents,
        documentAnalyses,
        eligibilityAssessments,
        savedScholarships,
        applications,
        scholarships,
        previousActions: latestSaved?.recommendedActions ?? [],
      }),
    [
      profile,
      documents,
      documentAnalyses,
      eligibilityAssessments,
      savedScholarships,
      applications,
      scholarships,
      latestSaved,
    ]
  );

  const report = serverReport ?? liveReport;
  const displayedActions = actionItems.length > 0 ? actionItems : report.recommendedActions;
  const isStaleSnapshot =
    Boolean(latestSaved?.dataFingerprint) &&
    latestSaved?.dataFingerprint !== liveReport.dataFingerprint;

  const handleRecalculate = async () => {
    if (!user) return;
    setError(null);
    setRecalculating(true);
    try {
      await runServerAssessment({
        uid: user.uid,
        docsRes: documents,
        anaRes: documentAnalyses,
        eligRes: eligibilityAssessments,
        savedRes: savedScholarships,
        appsRes: applications,
        latestSaved,
        includeAiExplanation: false,
        persistIfChanged: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to recalculate readiness assessment.');
    } finally {
      setRecalculating(false);
    }
  };

  const handleGenerateAiBriefing = async () => {
    if (!user) return;
    setError(null);
    setGeneratingAi(true);
    try {
      await runServerAssessment({
        uid: user.uid,
        docsRes: documents,
        anaRes: documentAnalyses,
        eligRes: eligibilityAssessments,
        savedRes: savedScholarships,
        appsRes: applications,
        latestSaved,
        includeAiExplanation: true,
        persistIfChanged: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate AI readiness briefing.');
    } finally {
      setGeneratingAi(false);
    }
  };

  const handleActionStatusChange = async (actionId: string, newStatus: ReadinessActionStatus) => {
    if (!user) return;
    setSavingActionId(actionId);
    setError(null);

    const updatedActions = displayedActions.map((item) =>
      item.id === actionId ? { ...item, status: newStatus } : item
    );
    setActionItems(updatedActions);

    try {
      if (latestSaved && latestSaved.dataFingerprint === report.dataFingerprint) {
        await updateReadinessAssessmentActions(latestSaved.id, {
          recommendedActions: updatedActions,
          aiActionPlan: aiActionPlan ?? latestSaved.aiActionPlan,
          updatedAt: new Date().toISOString(),
        });
        setAssessments((prev) =>
          prev.map((a) =>
            a.id === latestSaved.id
              ? { ...a, recommendedActions: updatedActions, updatedAt: new Date().toISOString() }
              : a
          )
        );
      } else {
        await persistSnapshot(user.uid, report, aiActionPlan ?? undefined, updatedActions);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save action item status.');
    } finally {
      setSavingActionId(null);
    }
  };

  const filteredActions = useMemo(() => {
    if (actionFilter === 'All') return displayedActions;
    return displayedActions.filter((a) => a.status === actionFilter);
  }, [displayedActions, actionFilter]);

  const filteredScholarships = useMemo<ScholarshipSpecificReadiness[]>(() => {
    switch (schemeFilter) {
      case 'Eligible & Potential':
        return report.scholarshipReadiness.filter(
          (s) =>
            s.eligibilityStatus === 'Eligible' || s.eligibilityStatus === 'Potentially Eligible'
        );
      case 'Saved & Tracked':
        return report.scholarshipReadiness.filter(
          (s) => s.isSaved || s.trackerStatus !== 'Not Tracked'
        );
      case 'Not Eligible':
        return report.scholarshipReadiness.filter((s) => s.eligibilityStatus === 'Not Eligible');
      default:
        return report.scholarshipReadiness;
    }
  }, [report.scholarshipReadiness, schemeFilter]);

  const actionCounts = useMemo(() => {
    return {
      All: displayedActions.length,
      Pending: displayedActions.filter((a) => a.status === 'Pending').length,
      'In Progress': displayedActions.filter((a) => a.status === 'In Progress').length,
      Completed: displayedActions.filter((a) => a.status === 'Completed').length,
    };
  }, [displayedActions]);

  return (
    <AppShell
      title="Scholarship Readiness Intelligence"
      breadcrumb="Workspace / Scholarship Readiness"
      primaryAction={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRecalculate}
            disabled={loading || recalculating}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-semibold text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-xl disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${recalculating ? 'animate-spin' : ''}`} />
            <span>{recalculating ? 'Recalculating...' : 'Recalculate Score'}</span>
          </button>
          <button
            type="button"
            onClick={handleGenerateAiBriefing}
            disabled={loading || generatingAi}
            className="btn-primary-gradient inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold rounded-xl disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Sparkles className="w-4 h-4" />
            <span>
              {generatingAi
                ? 'Analyzing...'
                : aiActionPlan
                  ? 'Refresh AI Briefing'
                  : 'Explain Score with AI'}
            </span>
          </button>
        </div>
      }
    >
      <PageTransition>
        <div className="space-y-6">
          {error && (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-sm text-rose-200 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {/* Data Availability / Incomplete Assessment Banner */}
          {(report.assessmentStatus === 'No Scholarship Data' ||
            report.assessmentStatus === 'Assessment Incomplete') && (
            <div className="p-5 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold text-amber-100">
                    {report.assessmentStatus === 'No Scholarship Data'
                      ? 'Scholarship Database Unavailable for Full Readiness Scoring'
                      : 'Assessment Incomplete — Insufficient Profile & Document Data'}
                  </h2>
                  <p className="text-xs sm:text-sm text-amber-200/90 leading-relaxed">
                    {report.dataAvailabilityWarning ??
                      'Complete your core student profile fields or upload a document so GRANTLY AI can compute verified scholarship readiness across all 5 dimensions.'}
                  </p>
                </div>
              </div>
              <Link
                to={report.assessmentStatus === 'No Scholarship Data' ? '/scholarships' : '/onboarding'}
                className="px-4 py-2 text-xs font-semibold text-amber-950 bg-amber-300 hover:bg-amber-200 rounded-xl whitespace-nowrap shrink-0"
              >
                {report.assessmentStatus === 'No Scholarship Data'
                  ? 'Inspect Scholarship Catalog'
                  : 'Complete Student Profile'}
              </Link>
            </div>
          )}

          {/* Stale Snapshot Banner */}
          {isStaleSnapshot && (
            <div className="p-4 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-2.5 text-xs sm:text-sm text-indigo-100">
                <RefreshCw className="w-4 h-4 text-indigo-300 shrink-0 mt-0.5" />
                <span>
                  Your profile, documents, or application tracker changed since the last saved snapshot. Recalculate to update your persisted readiness record.
                </span>
              </div>
              <button
                type="button"
                onClick={handleRecalculate}
                disabled={recalculating}
                className="btn-primary-gradient px-3.5 py-1.5 text-xs font-semibold rounded-xl whitespace-nowrap shrink-0"
              >
                {recalculating ? 'Updating...' : 'Update Saved Snapshot'}
              </button>
            </div>
          )}

          {loading ? (
            <div className="space-y-4">
              <SkeletonCard className="h-44" />
              <div className="grid md:grid-cols-2 xl:grid-cols-5 gap-4">
                <SkeletonCard className="h-40" />
                <SkeletonCard className="h-40" />
                <SkeletonCard className="h-40" />
                <SkeletonCard className="h-40" />
                <SkeletonCard className="h-40" />
              </div>
            </div>
          ) : (
            <>
              {/* Top Summary Card: Overall Readiness + Circular Gauge + KPIs */}
              <section className="surface-card p-6 space-y-5">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-6 max-w-2xl">
                    <CircularProgressRing
                      percent={report.overallScore ?? 0}
                      size={112}
                      strokeWidth={9}
                      label={report.overallScore === null ? 'N/A' : `${report.overallScore}`}
                      sublabel={report.overallScore === null ? 'Incomplete' : 'out of 100'}
                      tone={getRingTone(report.overallScore)}
                    />

                    <div className="space-y-2">
                      <div className="text-xs font-medium text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>Engine {report.algorithmVersion}</span>
                        <span aria-hidden="true">·</span>
                        <span className={`font-semibold ${getStatusTextClass(report.assessmentStatus)}`}>
                          {report.assessmentStatus}
                        </span>
                        {latestSaved && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono-num">
                              Saved {new Date(latestSaved.updatedAt || latestSaved.createdAt).toLocaleString('en-IN')}
                            </span>
                          </>
                        )}
                      </div>

                      <div className="flex items-baseline gap-3">
                        {report.overallScore === null ? (
                          <p className="text-2xl sm:text-3xl font-bold text-white font-display">
                            {report.assessmentStatus}
                          </p>
                        ) : (
                          <p className="text-3xl sm:text-4xl font-bold text-white font-mono-num">
                            <AnimatedCounter value={report.overallScore} />
                            <span className="text-lg font-medium text-slate-400"> / 100</span>
                          </p>
                        )}
                        <span className="text-xs text-slate-400 font-mono-num">
                          ({report.scholarshipsAvailableCount} active scheme(s) evaluated)
                        </span>
                      </div>

                      <div className="w-full max-w-md h-2 bg-slate-800/80 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${getProgressBarColor(
                            report.overallScore,
                            report.assessmentStatus
                          )}`}
                          style={{ width: `${report.overallScore ?? 0}%` }}
                        />
                      </div>

                      <p className="text-xs text-slate-400 leading-relaxed pt-0.5">
                        {report.disclaimer}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 shrink-0">
                    <div className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800">
                      <p className="text-xs text-slate-400">Profile</p>
                      <p className="text-lg font-bold text-white font-mono-num mt-1">
                        <AnimatedCounter value={report.profileCompletenessPercent} suffix="%" />
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800">
                      <p className="text-xs text-slate-400">Doc Coverage</p>
                      <p className="text-lg font-bold text-white font-mono-num mt-1">
                        {report.assessmentStatus === 'No Scholarship Data' ? (
                          'N/A'
                        ) : (
                          <AnimatedCounter value={report.documentCoveragePercent} suffix="%" />
                        )}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800 col-span-2 sm:col-span-1">
                      <p className="text-xs text-slate-400">Open Actions</p>
                      <p className="text-lg font-bold text-white font-mono-num mt-1">
                        <AnimatedCounter value={actionCounts.Pending + actionCounts['In Progress']} />
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              {/* 5 Dimension Score Breakdown Cards */}
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-white font-display">
                    Readiness Dimension Breakdown
                  </h2>
                  <span className="text-xs text-slate-400">
                    Weighted across 5 independent non-overlapping signals
                  </span>
                </div>

                <StaggerGrid className="grid md:grid-cols-2 xl:grid-cols-5 gap-4">
                  {report.dimensionScores.map((dim) => {
                    const isExpanded = expandedDimension === dim.key;
                    return (
                      <StaggerItem key={dim.key}>
                        <div className="surface-card surface-interactive p-5 flex flex-col justify-between space-y-3 h-full">
                          <div className="space-y-2.5">
                            <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                              <span className="font-mono-num">Weight {dim.weightPercent}%</span>
                              <span className={`font-semibold ${getStatusTextClass(dim.status)}`}>
                                {dim.status}
                              </span>
                            </div>
                            <h3 className="text-sm font-semibold text-white">{dim.label}</h3>

                            <div className="flex items-baseline justify-between">
                              <p className="text-2xl font-bold text-white font-mono-num">
                                {dim.scorePercent === null ? 'N/A' : `${dim.scorePercent}%`}
                              </p>
                              <span className="text-xs text-slate-400 font-mono-num">
                                {dim.earnedPoints} / {dim.maxPoints} pts
                              </span>
                            </div>

                            <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${getProgressBarColor(
                                  dim.scorePercent
                                )}`}
                                style={{ width: `${dim.scorePercent ?? 0}%` }}
                              />
                            </div>

                            <p className="text-xs text-slate-400 leading-relaxed">{dim.summary}</p>
                          </div>

                          {dim.deductionReasons.length > 0 && (
                            <div className="pt-2.5 border-t border-slate-800/80">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedDimension(isExpanded ? null : dim.key)
                                }
                                className="w-full flex items-center justify-between text-xs font-medium text-indigo-300 hover:text-indigo-200"
                              >
                                <span>
                                  {dim.deductionReasons.length} deduction note
                                  {dim.deductionReasons.length > 1 ? 's' : ''}
                                </span>
                                {isExpanded ? (
                                  <ChevronUp className="w-3.5 h-3.5" />
                                ) : (
                                  <ChevronDown className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <AnimatePresence>
                                {isExpanded && (
                                  <motion.ul
                                    initial={{ opacity: 0, y: -4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                    className="mt-2 space-y-1.5 text-xs text-slate-300"
                                  >
                                    {dim.deductionReasons.map((reason, idx) => (
                                      <li key={idx} className="leading-relaxed">
                                        · {reason}
                                      </li>
                                    ))}
                                  </motion.ul>
                                )}
                              </AnimatePresence>
                            </div>
                          )}
                        </div>
                      </StaggerItem>
                    );
                  })}
                </StaggerGrid>
              </section>

              {/* Missing Information & Document Readiness Split */}
              <section className="grid lg:grid-cols-12 gap-6">
                <div className="lg:col-span-5 surface-card p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <UserCheck className="w-4 h-4 text-indigo-400" />
                      <h2 className="text-base font-semibold text-white font-display">
                        Missing Profile &amp; Academic Fields
                      </h2>
                    </div>
                    <Link
                      to="/profile"
                      className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 hover:underline"
                    >
                      Edit Profile
                    </Link>
                  </div>

                  {report.missingProfileFields.length === 0 ? (
                    <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>All 12 core student profile fields are populated.</span>
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {report.missingProfileFields.map((field) => (
                        <li
                          key={field}
                          className="px-3.5 py-2.5 rounded-xl bg-[#070C1B]/80 border border-slate-800 text-xs text-slate-200 flex items-center justify-between"
                        >
                          <span>{field}</span>
                          <Link
                            to="/profile"
                            className="text-indigo-300 font-semibold hover:text-indigo-200 hover:underline"
                          >
                            Fill field
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Verified Completed Requirements Toggle */}
                  <div className="pt-2.5 border-t border-slate-800/80">
                    <button
                      type="button"
                      onClick={() => setShowCompletedList((v) => !v)}
                      className="flex items-center justify-between w-full text-xs font-semibold text-slate-300 hover:text-white"
                    >
                      <span>Verified Completed Milestones ({report.completedRequirements.length})</span>
                      {showCompletedList ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                    </button>
                    <AnimatePresence>
                      {showCompletedList && (
                        <motion.ul
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className="mt-2.5 space-y-1.5 max-h-52 overflow-y-auto pr-1"
                        >
                          {report.completedRequirements.map((item, idx) => (
                            <li key={idx} className="text-xs text-emerald-200 flex items-start gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                              <span>{item}</span>
                            </li>
                          ))}
                        </motion.ul>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                <div className="lg:col-span-7 surface-card p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileWarning className="w-4 h-4 text-amber-400" />
                      <h2 className="text-base font-semibold text-white font-display">
                        Document Readiness &amp; Flagged Reviews
                      </h2>
                    </div>
                    <Link
                      to="/documents"
                      className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 hover:underline"
                    >
                      Open Document Vault
                    </Link>
                  </div>

                  {report.assessmentStatus === 'No Scholarship Data' ? (
                    <p className="text-xs text-slate-400">
                      Document checklist evaluation requires active scholarships in the database.
                    </p>
                  ) : report.missingDocuments.length === 0 && report.flaggedDocuments.length === 0 ? (
                    <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>
                        All required documents for your target scholarships are uploaded, readable, and verified.
                      </span>
                    </div>
                  ) : (
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <h3 className="text-xs font-semibold text-rose-300">
                          Missing Required Documents ({report.missingDocuments.length})
                        </h3>
                        {report.missingDocuments.length === 0 ? (
                          <p className="text-xs text-slate-400">None missing for current target schemes.</p>
                        ) : (
                          <ul className="space-y-1.5">
                            {report.missingDocuments.map((docName) => (
                              <li
                                key={docName}
                                className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/25 text-xs text-rose-200"
                              >
                                {docName}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="space-y-2">
                        <h3 className="text-xs font-semibold text-amber-300">
                          Needs Review / Unconfirmed ({report.flaggedDocuments.length})
                        </h3>
                        {report.flaggedDocuments.length === 0 ? (
                          <p className="text-xs text-slate-400">No flagged documents.</p>
                        ) : (
                          <ul className="space-y-1.5">
                            {report.flaggedDocuments.map((docName) => (
                              <li
                                key={docName}
                                className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200"
                              >
                                {docName}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* Priority-Based Personalized Action Plan + AI Briefing */}
              <section className="grid lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 surface-card p-6 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-semibold text-white font-display">
                        Personalized Action Plan
                      </h2>
                      <p className="text-xs text-slate-400">
                        Prioritized by impact (most scholarships unblocked first). Update progress as you prepare.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 p-1 bg-[#070C1B] border border-slate-800 rounded-xl">
                      {(['All', 'Pending', 'In Progress', 'Completed'] as const).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setActionFilter(tab)}
                          className={`px-2.5 py-1 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 transition-colors ${
                            actionFilter === tab
                              ? 'bg-indigo-600 text-white'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          {tab} ({actionCounts[tab]})
                        </button>
                      ))}
                    </div>
                  </div>

                  {filteredActions.length === 0 ? (
                    <div className="p-4 rounded-xl bg-[#070C1B]/75 border border-slate-800 text-xs text-slate-400">
                      {displayedActions.length === 0
                        ? 'No blocking readiness actions found.'
                        : `No actions with status "${actionFilter}".`}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {filteredActions.map((item) => (
                        <div
                          key={item.id}
                          className="p-4 rounded-xl border border-slate-800 bg-[#070C1B]/75 space-y-2.5"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="space-y-1">
                              <div className="text-xs flex flex-wrap items-center gap-x-2 gap-y-0.5 text-slate-400">
                                <span
                                  className={`font-semibold ${
                                    item.priority === 'High'
                                      ? 'text-rose-300'
                                      : item.priority === 'Medium'
                                        ? 'text-amber-300'
                                        : 'text-slate-300'
                                  }`}
                                >
                                  {item.priority} Priority
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono-num text-indigo-300 font-medium">
                                  Unblocks {item.unblocksCount} scheme{item.unblocksCount === 1 ? '' : 's'}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span>{item.sourceOfRequirement}</span>
                              </div>
                              <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              {(['Pending', 'In Progress', 'Completed'] as const).map((st) => (
                                <button
                                  key={st}
                                  type="button"
                                  disabled={savingActionId === item.id}
                                  onClick={() => handleActionStatusChange(item.id, st)}
                                  className={`px-2 py-1 text-[11px] font-medium rounded-lg border whitespace-nowrap transition-colors ${
                                    item.status === st
                                      ? st === 'Completed'
                                        ? 'bg-emerald-600 text-white border-emerald-500'
                                        : st === 'In Progress'
                                          ? 'bg-amber-600 text-white border-amber-500'
                                          : 'bg-indigo-600 text-white border-indigo-500'
                                      : 'bg-[#0B1224] text-slate-400 border-slate-800 hover:text-white hover:bg-slate-800'
                                  }`}
                                >
                                  {st}
                                </button>
                              ))}
                            </div>
                          </div>

                          <p className="text-xs text-slate-300 leading-relaxed">{item.explanation}</p>
                          <p className="text-xs text-slate-400">
                            <span className="font-semibold text-slate-200">Next Step:</span>{' '}
                            {item.suggestedNextStep}
                          </p>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                            {item.relatedScholarshipTitle ? (
                              <span className="text-slate-400 truncate max-w-md">
                                Related: {item.relatedScholarshipTitle}
                              </span>
                            ) : (
                              <span />
                            )}
                            {item.actionRoute && (
                              <Link
                                to={item.actionRoute}
                                className="inline-flex items-center gap-1 font-semibold text-indigo-300 hover:text-indigo-200 hover:underline shrink-0"
                              >
                                <span>Go to workspace</span>
                                <ArrowRight className="w-3.5 h-3.5" />
                              </Link>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Grounded AI Readiness Explanation & AI Companion Links */}
                <div className="lg:col-span-5 space-y-6">
                  <div className="surface-card p-6 space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-indigo-400" />
                        <h2 className="text-base font-semibold text-white font-display">
                          AI Readiness Briefing
                        </h2>
                      </div>
                      {aiReusedFromCache && (
                        <span className="text-[11px] text-slate-400">Cached for current snapshot</span>
                      )}
                    </div>

                    {aiActionPlan ? (
                      <div className="text-xs sm:text-sm text-slate-200 whitespace-pre-line leading-relaxed bg-[#070C1B]/80 border border-slate-800 rounded-xl p-4">
                        {aiActionPlan}
                      </div>
                    ) : (
                      <div className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800 space-y-3">
                        <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                          Generate a grounded Gemini readiness briefing explaining why your score is{' '}
                          <span className="font-semibold text-white">
                            {report.overallScore === null
                              ? report.assessmentStatus
                              : `${report.overallScore}/100`}
                          </span>{' '}
                          and the highest-impact steps for Indian scholarship portals.
                        </p>
                        <button
                          type="button"
                          onClick={handleGenerateAiBriefing}
                          disabled={generatingAi}
                          className="btn-primary-gradient inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-xl disabled:opacity-50"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          <span>{generatingAi ? 'Generating Briefing...' : 'Explain Score with Gemini'}</span>
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="surface-card p-6 space-y-3">
                    <div className="flex items-center gap-2">
                      <MessageSquareText className="w-4 h-4 text-indigo-400" />
                      <h2 className="text-base font-semibold text-white font-display">
                        Ask AI Companion About Readiness
                      </h2>
                    </div>
                    <p className="text-xs text-slate-400">
                      Open your grounded AI Companion pre-loaded with your exact 5-dimension readiness report:
                    </p>
                    <div className="space-y-2">
                      {READINESS_COMPANION_PROMPTS.map((q) => (
                        <Link
                          key={q}
                          to={`/companion?prompt=${encodeURIComponent(q)}`}
                          className="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-[#070C1B]/75 border border-slate-800 hover:border-indigo-500/40 hover:bg-[#101933] text-xs text-slate-200 transition-colors"
                        >
                          <span>{q}</span>
                          <ArrowRight className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {/* Scholarship-Specific Readiness Breakdown */}
              <section className="surface-card p-6 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-white font-display">
                      Scholarship-Specific Readiness Breakdown
                    </h2>
                    <p className="text-xs text-slate-400">
                      Evaluated deterministically against each scholarship&apos;s eligibility rules and published document checklist.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 p-1 bg-[#070C1B] border border-slate-800 rounded-xl">
                    {(['All', 'Eligible & Potential', 'Saved & Tracked', 'Not Eligible'] as const).map(
                      (tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setSchemeFilter(tab)}
                          className={`px-2.5 py-1 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 transition-colors ${
                            schemeFilter === tab
                              ? 'bg-indigo-600 text-white'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          {tab}
                        </button>
                      )
                    )}
                  </div>
                </div>

                {filteredScholarships.length === 0 ? (
                  <div className="p-5 rounded-xl bg-[#070C1B]/75 border border-slate-800 text-xs text-slate-400 flex items-center gap-2.5">
                    <ShieldAlert className="w-4 h-4 text-slate-500 shrink-0" />
                    <span>
                      {report.scholarshipReadiness.length === 0
                        ? 'No active scholarships are present in the database yet.'
                        : `No scholarships match the "${schemeFilter}" filter.`}
                    </span>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-800/80">
                    {filteredScholarships.map((item) => (
                      <div key={item.scholarshipId} className="py-4 first:pt-1 last:pb-1 space-y-2.5">
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                          <div className="space-y-1 min-w-0">
                            <div className="text-xs text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span>{item.scholarshipType}</span>
                              <span aria-hidden="true">·</span>
                              <span className={`font-semibold ${getStatusTextClass(item.eligibilityStatus)}`}>
                                {item.eligibilityStatus}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{item.trackerStatus}</span>
                              {!item.isSourceVerified && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-amber-300 font-medium">
                                    Source: {item.verificationStatus}
                                  </span>
                                </>
                              )}
                            </div>

                            <Link
                              to={`/scholarships/${item.scholarshipId}`}
                              className="text-sm font-semibold text-white hover:text-indigo-300 block transition-colors"
                            >
                              {item.scholarshipTitle}
                            </Link>
                            <p className="text-xs text-slate-400">
                              {item.provider} · Deadline: {item.applicationDeadline} ({item.effectiveApplicationStatus})
                            </p>
                          </div>

                          <div className="sm:text-right shrink-0 space-y-0.5">
                            <p className="text-lg font-bold text-white font-mono-num">
                              {item.readinessPercent === null ? 'N/A' : `${item.readinessPercent}%`}
                            </p>
                            <p className={`text-xs font-semibold ${getStatusTextClass(item.readinessLabel)}`}>
                              {item.readinessLabel}
                            </p>
                          </div>
                        </div>

                        <div className="grid sm:grid-cols-3 gap-2.5 text-xs">
                          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25">
                            <span className="font-semibold text-emerald-300">Ready Docs: </span>
                            <span className="text-emerald-100/90">
                              {item.availableDocuments.length > 0
                                ? item.availableDocuments.join(', ')
                                : 'None ready yet'}
                            </span>
                          </div>
                          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25">
                            <span className="font-semibold text-amber-300">Needs Review: </span>
                            <span className="text-amber-100/90">
                              {item.needsReviewDocuments.length > 0
                                ? item.needsReviewDocuments.join(', ')
                                : 'None'}
                            </span>
                          </div>
                          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25">
                            <span className="font-semibold text-rose-300">Missing Docs: </span>
                            <span className="text-rose-100/90">
                              {item.missingDocuments.length > 0
                                ? item.missingDocuments.join(', ')
                                : 'None missing'}
                            </span>
                          </div>
                        </div>

                        {(item.failedCriteria.length > 0 || item.unknownCriteria.length > 0) && (
                          <p className="text-xs text-slate-400">
                            {item.failedCriteria.length > 0 && (
                              <span className="text-rose-300 font-medium">
                                Failed rules: {item.failedCriteria.join(', ')}.{' '}
                              </span>
                            )}
                            {item.unknownCriteria.length > 0 && (
                              <span className="text-amber-300 font-medium">
                                Unknown criteria: {item.unknownCriteria.join(', ')}.
                              </span>
                            )}
                          </p>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs pt-0.5">
                          <p className="text-slate-300">
                            <span className="font-semibold text-white">Next Action:</span>{' '}
                            {item.nextRecommendedAction}
                          </p>
                          <div className="flex items-center gap-3 shrink-0">
                            <Link
                              to={`/scholarships/${item.scholarshipId}`}
                              className="text-indigo-300 font-semibold hover:text-indigo-200 hover:underline"
                            >
                              Eligibility Details
                            </Link>
                            {item.officialUrl && (
                              <a
                                href={item.officialUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-slate-400 hover:text-white"
                              >
                                <span>Official Portal</span>
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </PageTransition>
    </AppShell>
  );
}
