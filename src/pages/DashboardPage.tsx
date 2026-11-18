import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Bookmark,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileSearch,
  MessageSquare,
  ShieldCheck,
  Sparkles,
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
import {
  getApplications,
  getDocumentAnalyses,
  getDocuments,
  getEligibilityAssessments,
  getSavedScholarships,
  getScholarships,
} from '../lib/firestoreRepo.ts';
import { evaluateTrackedApplication } from '../lib/applicationTrackerEngine.ts';
import { computeProfileCompleteness } from '../lib/eligibilityEngine.ts';
import { evaluateScholarshipReadiness } from '../lib/readinessEngine.ts';
import {
  getEffectiveApplicationStatus,
  isVerifiedStatus,
  parseDeadlineTimestamp,
  rankRecommendedScholarships,
} from '../lib/scholarshipEngine.ts';
import { peekPublicCache, peekUserCache } from '../lib/workspaceCache.ts';
import type {
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  EligibilityAssessment,
  SavedScholarship,
  Scholarship,
} from '../types/database.ts';

export default function DashboardPage() {
  const { user, profile } = useAuth();
  const cachedSch = peekPublicCache<{ items: Scholarship[]; isEmptyDatabase: boolean }>('scholarships');
  const cachedApps = peekUserCache<ApplicationRecord[]>(user?.uid, 'applications');
  const cachedSaved = peekUserCache<SavedScholarship[]>(user?.uid, 'saved_scholarships');
  const cachedDocs = peekUserCache<DocumentRecord[]>(user?.uid, 'documents');
  const cachedAnalyses = peekUserCache<DocumentAnalysis[]>(user?.uid, 'document_analysis');
  const cachedElig = peekUserCache<EligibilityAssessment[]>(user?.uid, 'eligibility_assessments');

  const hasWarmCache = Boolean(
    cachedSch && cachedApps && cachedSaved && cachedDocs && cachedAnalyses && cachedElig
  );

  const [scholarships, setScholarships] = useState<Scholarship[]>(() => cachedSch?.items ?? []);
  const [isEmptyDatabase, setIsEmptyDatabase] = useState<boolean>(
    () => cachedSch?.isEmptyDatabase ?? false
  );
  const [applications, setApplications] = useState<ApplicationRecord[]>(() => cachedApps ?? []);
  const [saved, setSaved] = useState<SavedScholarship[]>(() => cachedSaved ?? []);
  const [documents, setDocuments] = useState<DocumentRecord[]>(() => cachedDocs ?? []);
  const [documentAnalyses, setDocumentAnalyses] = useState<DocumentAnalysis[]>(
    () => cachedAnalyses ?? []
  );
  const [eligibilityAssessments, setEligibilityAssessments] = useState<EligibilityAssessment[]>(
    () => cachedElig ?? []
  );
  const [loading, setLoading] = useState(!hasWarmCache);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    if (!user) return;
    setError(null);
    const [schRes, appsRes, savedRes, docsRes, anaRes, eligRes] = await Promise.all([
      getScholarships(),
      getApplications(user.uid),
      getSavedScholarships(user.uid),
      getDocuments(user.uid),
      getDocumentAnalyses(user.uid),
      getEligibilityAssessments(user.uid),
    ]);
    setScholarships(schRes.items);
    setIsEmptyDatabase(schRes.isEmptyDatabase);
    setApplications(appsRes);
    setSaved(savedRes);
    setDocuments(docsRes);
    setDocumentAnalyses(anaRes);
    setEligibilityAssessments(eligRes);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    loadDashboard()
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unable to load dashboard records.');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user, loadDashboard]);

  const completeness = useMemo(() => computeProfileCompleteness(profile), [profile]);
  const readinessReport = useMemo(
    () =>
      evaluateScholarshipReadiness({
        profile,
        documents,
        documentAnalyses,
        eligibilityAssessments,
        savedScholarships: saved,
        applications,
        scholarships,
      }),
    [profile, documents, documentAnalyses, eligibilityAssessments, saved, applications, scholarships]
  );

  // Genuine deterministic matching (only shows when profile is present & non-expired)
  const recommendedScholarships = useMemo(
    () => (profile?.onboardingCompleted ? rankRecommendedScholarships(scholarships, profile, 4) : []),
    [scholarships, profile]
  );

  const recentlyVerified = useMemo(() => {
    return scholarships
      .filter((s) => isVerifiedStatus(s.verificationStatus))
      .sort((a, b) => (b.lastVerifiedDate || b.updatedAt).localeCompare(a.lastVerifiedDate || a.updatedAt))
      .slice(0, 4);
  }, [scholarships]);

  const upcomingDeadlines = useMemo(() => {
    const nowTs = Date.now();
    return scholarships
      .map((s) => ({
        scholarship: s,
        deadlineTs: parseDeadlineTimestamp(s.applicationDeadline),
        effectiveStatus: getEffectiveApplicationStatus(s),
      }))
      .filter(
        (item) =>
          item.deadlineTs !== null &&
          item.deadlineTs >= nowTs &&
          item.effectiveStatus !== 'Closed' &&
          item.effectiveStatus !== 'Expired'
      )
      .sort((a, b) => (a.deadlineTs ?? 0) - (b.deadlineTs ?? 0))
      .slice(0, 4);
  }, [scholarships]);

  const savedScholarshipRecords = useMemo(() => {
    const map = new Map(scholarships.map((s) => [s.id, s]));
    return saved.map((item) => map.get(item.scholarshipId)).filter((x): x is Scholarship => Boolean(x));
  }, [scholarships, saved]);

  const openOpportunities = useMemo(() => {
    return scholarships
      .filter((s) => {
        const eff = getEffectiveApplicationStatus(s);
        return eff !== 'Expired' && eff !== 'Closed';
      })
      .slice(0, 4);
  }, [scholarships]);

  const evaluatedTrackedApps = useMemo(() => {
    const schMap = new Map(scholarships.map((s) => [s.id, s]));
    return applications.slice(0, 4).map((appItem) =>
      evaluateTrackedApplication({
        application: appItem,
        scholarship: schMap.get(appItem.scholarshipId) ?? null,
        profile,
        documents,
        documentAnalyses,
      })
    );
  }, [applications, scholarships, profile, documents, documentAnalyses]);

  const firstName = (profile?.fullName || user?.displayName || 'Student').split(' ')[0];
  const completedDocsCount = documents.filter((d) => d.processingStatus === 'Completed').length;

  return (
    <AppShell
      title="Student Dashboard"
      breadcrumb="Workspace / Overview"
      primaryAction={
        <Link
          to="/scholarships"
          className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold btn-primary-gradient rounded-xl whitespace-nowrap"
        >
          <span>Discover Scholarships</span>
          <ArrowRight className="w-4 h-4" />
        </Link>
      }
    >
      <PageTransition className="space-y-6">
        {/* Welcome Hero Card */}
        <section className="surface-elevated rounded-2xl p-6 sm:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
              Scholarship Command Center
            </p>
            <h2 className="text-xl sm:text-2xl font-bold text-white font-display tracking-tight">
              Welcome back, {firstName}
            </h2>
            <p className="text-xs sm:text-sm text-slate-400">
              {profile?.educationLevel || 'Education level unset'} · {profile?.state || 'Domicile state unset'} ·{' '}
              <span className="font-mono-num text-slate-300">
                {completedDocsCount}/{documents.length} docs analyzed
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <Link
              to="/companion"
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-indigo-200 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-400/30 rounded-xl transition-colors whitespace-nowrap"
            >
              <MessageSquare className="w-4 h-4 text-indigo-300" />
              <span>Ask AI Companion</span>
            </Link>
            <Link
              to="/documents"
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-200 bg-slate-900/80 hover:bg-slate-800 border border-slate-700/80 rounded-xl transition-colors whitespace-nowrap"
            >
              <FileSearch className="w-4 h-4 text-blue-300" />
              <span>Document Intelligence</span>
            </Link>
          </div>
        </section>

        {!profile?.onboardingCompleted && (
          <div className="rounded-2xl bg-amber-500/12 border border-amber-500/30 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold text-amber-100">Complete your student onboarding profile</h2>
                <p className="text-xs sm:text-sm text-amber-200/85 mt-0.5">
                  Your profile is currently {completeness.percent}% complete. Finish onboarding to unlock deterministic scholarship recommendations.
                </p>
              </div>
            </div>
            <Link
              to="/onboarding"
              className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-300 hover:bg-amber-200 rounded-xl whitespace-nowrap shrink-0"
            >
              Finish Onboarding
            </Link>
          </div>
        )}

        {error && (
          <div className="p-4 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-sm text-rose-200 flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void loadDashboard()
                  .catch((err) =>
                    setError(err instanceof Error ? err.message : 'Unable to load dashboard records.')
                  )
                  .finally(() => setLoading(false));
              }}
              className="px-3 py-1.5 text-xs font-semibold text-rose-100 bg-rose-500/25 hover:bg-rose-500/35 border border-rose-400/30 rounded-lg whitespace-nowrap"
            >
              Retry
            </button>
          </div>
        )}

        {/* KPI Strip */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((k) => (
              <SkeletonCard key={k} className="h-32" />
            ))}
          </div>
        ) : (
          <StaggerGrid className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StaggerItem>
              <div className="h-full surface-card surface-interactive rounded-2xl p-5 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-slate-400">Profile Completeness</p>
                  <p className="text-2xl font-bold text-white mt-1.5">
                    <AnimatedCounter value={completeness.percent} suffix="%" />
                  </p>
                  <Link to="/profile" className="text-xs text-indigo-300 hover:text-indigo-200 hover:underline mt-2 inline-block">
                    Update profile →
                  </Link>
                </div>
                <CircularProgressRing percent={completeness.percent} size={62} strokeWidth={6} tone="indigo" />
              </div>
            </StaggerItem>

            <StaggerItem>
              <div className="h-full surface-card surface-interactive rounded-2xl p-5 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-slate-400">Application Readiness</p>
                  <p className="text-2xl font-bold text-white mt-1.5 font-mono-num">
                    {readinessReport.overallScore === null ? (
                      readinessReport.assessmentStatus === 'No Scholarship Data' ? 'No Data' : 'Incomplete'
                    ) : (
                      <AnimatedCounter value={readinessReport.overallScore} suffix="%" />
                    )}
                  </p>
                  <Link to="/readiness" className="text-xs text-indigo-300 hover:text-indigo-200 hover:underline mt-2 inline-block">
                    View readiness →
                  </Link>
                </div>
                <CircularProgressRing
                  percent={readinessReport.overallScore ?? 0}
                  label={readinessReport.overallScore === null ? '—' : `${readinessReport.overallScore}%`}
                  size={62}
                  strokeWidth={6}
                  tone={
                    (readinessReport.overallScore ?? 0) >= 75
                      ? 'emerald'
                      : (readinessReport.overallScore ?? 0) >= 45
                        ? 'amber'
                        : 'indigo'
                  }
                />
              </div>
            </StaggerItem>

            <StaggerItem>
              <div className="h-full surface-card surface-interactive rounded-2xl p-5 flex flex-col justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-400">Saved Scholarships</p>
                  <p className="text-2xl font-bold text-white mt-1.5">
                    <AnimatedCounter value={saved.length} />
                  </p>
                </div>
                <Link to="/scholarships" className="text-xs text-indigo-300 hover:text-indigo-200 hover:underline mt-2 inline-block">
                  Browse directory →
                </Link>
              </div>
            </StaggerItem>

            <StaggerItem>
              <div className="h-full surface-card surface-interactive rounded-2xl p-5 flex flex-col justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-400">Tracked Applications</p>
                  <p className="text-2xl font-bold text-white mt-1.5">
                    <AnimatedCounter value={applications.length} />
                  </p>
                </div>
                <Link to="/applications" className="text-xs text-indigo-300 hover:text-indigo-200 hover:underline mt-2 inline-block">
                  Open tracker →
                </Link>
              </div>
            </StaggerItem>
          </StaggerGrid>
        )}

        {/* Pending Action Steps from Readiness Engine (if any) */}
        {!loading && readinessReport.recommendedActions.filter((a) => a.status !== 'Completed').length > 0 && (
          <section className="surface-card rounded-2xl p-5 sm:p-6 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-300" />
                <h2 className="text-sm font-semibold text-white font-display">
                  Priority Next Actions
                </h2>
              </div>
              <Link to="/readiness" className="text-xs font-semibold text-indigo-300 hover:underline">
                Full Action Plan →
              </Link>
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              {readinessReport.recommendedActions
                .filter((a) => a.status !== 'Completed')
                .slice(0, 3)
                .map((item) => (
                  <Link
                    key={item.id}
                    to={item.actionRoute || '/readiness'}
                    className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 hover:border-indigo-400/40 transition-colors space-y-1"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-300">
                      {item.priority} Priority · {item.sourceOfRequirement}
                    </p>
                    <p className="text-xs font-semibold text-slate-100 line-clamp-1">{item.title}</p>
                    <p className="text-[11px] text-slate-400 line-clamp-2">{item.explanation}</p>
                  </Link>
                ))}
            </div>
          </section>
        )}

        {/* 1. Recommended Scholarships + 2. Recently Verified */}
        <div className="grid lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 surface-card rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-white font-display">
                  Recommended Scholarships
                </h2>
                <p className="text-xs text-slate-400">
                  Ranked by deterministic profile eligibility (state, income, level, category, marks)
                </p>
              </div>
              <Link to="/scholarships" className="text-xs font-semibold text-indigo-300 hover:underline">
                View all
              </Link>
            </div>

            {isEmptyDatabase ? (
              <p className="text-xs text-slate-400 py-4">
                No scholarship schemes are currently available in the catalog.
              </p>
            ) : !profile?.onboardingCompleted ? (
              <p className="text-xs text-slate-300 py-4">
                Complete your onboarding profile to generate rule-verified recommendations tailored to your parameters.
              </p>
            ) : recommendedScholarships.length === 0 ? (
              <p className="text-xs text-slate-400 py-4">
                No active scholarships currently match all your profile constraints. Check Discovery with relaxed filters.
              </p>
            ) : (
              <div className="divide-y divide-slate-800/80">
                {recommendedScholarships.map(({ scholarship, effectiveStatus, overallStatus, compatibilityScore }) => (
                  <div key={scholarship.id} className="py-3.5 first:pt-1 last:pb-1 flex items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="text-xs text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span>{scholarship.scholarshipType}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={
                            overallStatus === 'Eligible'
                              ? 'text-emerald-400 font-semibold'
                              : overallStatus === 'Potentially Eligible'
                                ? 'text-amber-300 font-semibold'
                                : 'text-slate-300 font-medium'
                          }
                        >
                          {overallStatus} ({compatibilityScore}%)
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{effectiveStatus}</span>
                      </div>
                      <Link
                        to={`/scholarships/${scholarship.id}`}
                        className="text-sm font-semibold text-white hover:text-indigo-300 block truncate transition-colors"
                      >
                        {scholarship.title}
                      </Link>
                      <p className="text-xs text-slate-400 truncate">{scholarship.provider}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-indigo-200 font-mono-num">
                        {scholarship.annualAwardInr ? `₹${scholarship.annualAwardInr.toLocaleString('en-IN')}` : 'Variable'}
                      </p>
                      <Link to={`/scholarships/${scholarship.id}`} className="text-xs text-indigo-300 hover:underline">
                        Details
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="lg:col-span-5 surface-card rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <h2 className="text-base font-semibold text-white font-display">
                  Recently Verified
                </h2>
              </div>
              <Link to="/scholarships" className="text-xs font-semibold text-indigo-300 hover:underline">
                Browse
              </Link>
            </div>
            {recentlyVerified.length === 0 ? (
              <p className="text-xs text-slate-400">No verified records found in database yet.</p>
            ) : (
              <div className="divide-y divide-slate-800/80">
                {recentlyVerified.map((s) => (
                  <div key={s.id} className="py-3 first:pt-0 last:pb-0 space-y-1">
                    <Link
                      to={`/scholarships/${s.id}`}
                      className="text-xs sm:text-sm font-semibold text-slate-100 hover:text-indigo-300 block truncate transition-colors"
                    >
                      {s.title}
                    </Link>
                    <p className="text-xs text-slate-400">
                      Verified <span className="font-mono-num text-slate-300">{s.lastVerifiedDate || 'Official Source'}</span> · {s.scholarshipType}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 3. Upcoming Deadlines + 4. Saved Scholarships + 5. Application Opportunities */}
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="surface-card rounded-2xl p-6 space-y-3">
            <div className="flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-white font-display">
                Upcoming Deadlines
              </h2>
            </div>
            {upcomingDeadlines.length === 0 ? (
              <p className="text-xs text-slate-400 leading-relaxed">
                No fixed upcoming cycle dates are currently published. Always verify active window dates on official portals before applying.
              </p>
            ) : (
              <div className="divide-y divide-slate-800/80">
                {upcomingDeadlines.map(({ scholarship }) => (
                  <div key={scholarship.id} className="py-2.5 text-xs space-y-0.5">
                    <Link to={`/scholarships/${scholarship.id}`} className="font-semibold text-slate-100 hover:text-indigo-300 block truncate">
                      {scholarship.title}
                    </Link>
                    <p className="text-amber-300 font-mono-num">
                      Due: {scholarship.applicationDeadline}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="surface-card rounded-2xl p-6 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bookmark className="w-4 h-4 text-indigo-400" />
                <h2 className="text-sm font-semibold text-white font-display">
                  Saved Scholarships
                </h2>
              </div>
              <Link to="/scholarships" className="text-xs text-indigo-300 hover:underline">
                Manage
              </Link>
            </div>
            {savedScholarshipRecords.length === 0 ? (
              <p className="text-xs text-slate-400">
                No saved scholarships yet. Bookmark schemes in Discovery to review them here.
              </p>
            ) : (
              <div className="divide-y divide-slate-800/80">
                {savedScholarshipRecords.slice(0, 4).map((s) => (
                  <div key={s.id} className="py-2.5 text-xs flex items-center justify-between gap-2">
                    <Link to={`/scholarships/${s.id}`} className="font-medium text-slate-100 hover:text-indigo-300 truncate">
                      {s.title}
                    </Link>
                    <a
                      href={s.officialUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-300 hover:text-indigo-200 shrink-0"
                      aria-label="Open official portal"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="surface-card rounded-2xl p-6 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ClipboardCheck className="w-4 h-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-white font-display">
                  Application Opportunities
                </h2>
              </div>
              <Link to="/applications" className="text-xs text-indigo-300 hover:underline">
                Tracker
              </Link>
            </div>
            {evaluatedTrackedApps.length > 0 ? (
              <div className="divide-y divide-slate-800/80">
                {evaluatedTrackedApps.map((ev) => (
                  <div key={ev.application.id} className="py-2.5 text-xs flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        to={`/applications/${ev.application.id}`}
                        className="font-medium text-slate-100 hover:text-indigo-300 truncate block"
                      >
                        {ev.application.scholarshipTitle}
                      </Link>
                      <span className="text-[11px] text-slate-400 font-mono-num">
                        {ev.deadline.displayLabel}
                      </span>
                    </div>
                    <span
                      className={`shrink-0 font-semibold ${
                        ev.needsAttention ? 'text-amber-300' : 'text-slate-300'
                      }`}
                    >
                      {ev.normalizedStatus}
                    </span>
                  </div>
                ))}
              </div>
            ) : openOpportunities.length > 0 ? (
              <div className="divide-y divide-slate-800/80">
                {openOpportunities.map((s) => (
                  <div key={s.id} className="py-2.5 text-xs flex items-center justify-between gap-2">
                    <Link to={`/scholarships/${s.id}`} className="font-medium text-slate-100 hover:text-indigo-300 truncate">
                      {s.title}
                    </Link>
                    <span className="inline-flex items-center gap-1 text-emerald-400 shrink-0">
                      <CheckCircle2 className="w-3 h-3" /> Open
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400">
                No active application opportunities found yet.
              </p>
            )}
          </div>
        </div>
      </PageTransition>
    </AppShell>
  );
}
