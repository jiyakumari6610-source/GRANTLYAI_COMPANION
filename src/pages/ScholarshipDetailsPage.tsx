import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Bookmark,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import { PageTransition, SkeletonCard } from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { postProtectedAi } from '../lib/apiClient.ts';
import {
  findDuplicateActiveApplication,
  normalizeApplicationStatus,
} from '../lib/applicationTrackerEngine.ts';
import { evaluateDeterministicEligibility } from '../lib/eligibilityEngine.ts';
import {
  getApplications,
  getSavedScholarships,
  getScholarshipById,
  toggleSavedScholarship,
} from '../lib/firestoreRepo.ts';
import { getEffectiveApplicationStatus } from '../lib/scholarshipEngine.ts';
import { peekPublicCache, peekUserCache } from '../lib/workspaceCache.ts';
import type { ApplicationRecord, SavedScholarship, Scholarship } from '../types/database.ts';

export default function ScholarshipDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const { user, profile, getIdToken } = useAuth();
  const navigate = useNavigate();

  const cachedCatalog = peekPublicCache<{ items: Scholarship[]; isEmptyDatabase: boolean }>('scholarships');
  const initialScholarship = id
    ? cachedCatalog?.items.find((item) => item.id === id) ??
      peekPublicCache<Scholarship>(`scholarship:${id}`) ??
      null
    : null;
  const cachedSaved = peekUserCache<SavedScholarship[]>(user?.uid, 'saved_scholarships');
  const cachedApps = peekUserCache<ApplicationRecord[]>(user?.uid, 'applications');

  const [scholarship, setScholarship] = useState<Scholarship | null>(() => initialScholarship);
  const [savedId, setSavedId] = useState<string | undefined>(() =>
    id ? cachedSaved?.find((s) => s.scholarshipId === id)?.id : undefined
  );
  const [trackedApp, setTrackedApp] = useState<ApplicationRecord | null>(() =>
    id && cachedApps ? findDuplicateActiveApplication(cachedApps, id) : null
  );
  const [loading, setLoading] = useState(!initialScholarship);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let active = true;
    const warmCatalogItem =
      peekPublicCache<{ items: Scholarship[] }>('scholarships')?.items.find((item) => item.id === id) ??
      peekPublicCache<Scholarship>(`scholarship:${id}`) ??
      null;
    if (warmCatalogItem) {
      setScholarship(warmCatalogItem);
      setLoading(false);
    } else {
      setLoading(true);
    }

    (async () => {
      try {
        const item = await getScholarshipById(id);
        if (!active) return;
        setScholarship(item);

        if (user && item) {
          const [savedList, apps] = await Promise.all([
            getSavedScholarships(user.uid),
            getApplications(user.uid),
          ]);
          if (!active) return;
          const matchSaved = savedList.find((s) => s.scholarshipId === item.id);
          setSavedId(matchSaved?.id);
          setTrackedApp(findDuplicateActiveApplication(apps, item.id));
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id, user]);

  const eligibility = useMemo(() => {
    if (!scholarship) return null;
    return evaluateDeterministicEligibility(profile, scholarship);
  }, [profile, scholarship]);

  const handleToggleSave = async () => {
    if (!user || !scholarship) return;
    await toggleSavedScholarship(user.uid, scholarship.id, savedId);
    const savedList = await getSavedScholarships(user.uid);
    setSavedId(savedList.find((s) => s.scholarshipId === scholarship.id)?.id);
  };

  const handleStartTracking = async () => {
    if (!user || !scholarship) return;
    if (trackedApp) {
      navigate(`/applications/${trackedApp.id}`);
      return;
    }
    setTrackingBusy(true);
    setTrackError(null);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{ application: ApplicationRecord }>(
        '/api/applications',
        token,
        { scholarshipId: scholarship.id, initialStatus: 'Interested' }
      );
      setTrackedApp(res.application);
      navigate(`/applications/${res.application.id}`);
    } catch (err) {
      setTrackError(err instanceof Error ? err.message : 'Unable to start tracking this scholarship.');
    } finally {
      setTrackingBusy(false);
    }
  };

  if (loading) {
    return (
      <AppShell title="Scholarship Details" breadcrumb="Workspace / Discovery / Details">
        <SkeletonCard className="h-72" />
      </AppShell>
    );
  }

  if (!scholarship) {
    return (
      <AppShell title="Scholarship Not Found" breadcrumb="Workspace / Discovery">
        <div className="surface-card rounded-2xl p-8 text-center space-y-4">
          <p className="text-base font-semibold text-white">Scholarship record could not be located.</p>
          <Link to="/scholarships" className="text-sm font-medium text-indigo-300 hover:underline">
            Return to Scholarship Discovery
          </Link>
        </div>
      </AppShell>
    );
  }

  const effectiveStatus = getEffectiveApplicationStatus(scholarship);
  const isExpiredOrClosed = effectiveStatus === 'Expired' || effectiveStatus === 'Closed';
  const heldSet = new Set((profile?.certificates ?? []).map((c) => c.toLowerCase()));

  return (
    <AppShell
      title={scholarship.title}
      breadcrumb={`Workspace / Discovery / ${scholarship.scholarshipType}`}
      primaryAction={
        <a
          href={scholarship.officialUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold btn-primary-gradient rounded-xl whitespace-nowrap"
        >
          <span>Apply Now (Official Portal)</span>
          <ExternalLink className="w-4 h-4" />
        </a>
      }
    >
      <PageTransition className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            to="/scholarships"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Discovery</span>
          </Link>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleToggleSave}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-xl border transition-colors ${
                savedId
                  ? 'bg-indigo-500/20 border-indigo-400/40 text-indigo-200'
                  : 'bg-slate-900/70 border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Bookmark className="w-3.5 h-3.5" fill={savedId ? 'currentColor' : 'none'} />
              <span>{savedId ? 'Saved' : 'Save Scholarship'}</span>
            </button>

            <button
              type="button"
              onClick={handleStartTracking}
              disabled={trackingBusy}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold btn-primary-gradient rounded-xl disabled:opacity-60"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              <span>
                {trackedApp
                  ? `Tracked (${normalizeApplicationStatus(trackedApp.status)})`
                  : trackingBusy
                    ? 'Creating...'
                    : 'Track Application'}
              </span>
            </button>
          </div>
        </div>

        {trackError && (
          <div className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-xs text-rose-200">
            {trackError}
          </div>
        )}

        {isExpiredOrClosed && (
          <div className="p-4 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-sm text-rose-100 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Application Cycle {effectiveStatus}</p>
              <p className="text-xs text-rose-200/85 mt-0.5">
                This scholarship&rsquo;s recorded deadline ({scholarship.applicationDeadline}) is marked {effectiveStatus}. Verify the official portal before preparing a submission for the next cycle.
              </p>
            </div>
          </div>
        )}

        {/* Complete Description & Important Dates */}
        <div className="surface-elevated rounded-2xl p-6 sm:p-8 space-y-6">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="font-medium text-slate-200">{scholarship.provider}</span>
            <span aria-hidden="true">·</span>
            <span>{scholarship.scholarshipType}</span>
            <span aria-hidden="true">·</span>
            <span
              className={
                scholarship.verificationStatus === 'Verified' ||
                scholarship.verificationStatus === 'Verified Official Source'
                  ? 'text-emerald-400 font-semibold'
                  : 'text-amber-300 font-semibold'
              }
            >
              {scholarship.verificationStatus}
            </span>
            <span aria-hidden="true">·</span>
            <span className={isExpiredOrClosed ? 'text-rose-400 font-semibold' : 'text-slate-200 font-medium'}>
              {effectiveStatus}
            </span>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
              <p className="text-xs text-slate-400">Estimated Annual Award</p>
              <p className="text-lg font-bold text-indigo-200 font-mono-num mt-1">
                {scholarship.annualAwardInr
                  ? `₹${scholarship.annualAwardInr.toLocaleString('en-IN')}`
                  : 'Variable'}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
              <p className="text-xs text-slate-400">Family Income Range</p>
              <p className="text-sm font-bold text-white font-mono-num mt-1">
                {typeof scholarship.incomeLimitInr === 'number'
                  ? `₹${(scholarship.minIncomeLimitInr ?? 0).toLocaleString('en-IN')} – ₹${scholarship.incomeLimitInr.toLocaleString('en-IN')}`
                  : 'No Fixed Cap'}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
              <p className="text-xs text-slate-400">Application Start Date</p>
              <p className="text-sm font-semibold text-white font-mono-num mt-1">
                {scholarship.applicationStartDate || 'Check Official Portal'}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
              <p className="text-xs text-slate-400">Application Deadline</p>
              <p className="text-sm font-semibold text-white font-mono-num mt-1">
                {scholarship.applicationDeadline || 'Check Official Portal'}
              </p>
            </div>
          </div>

          {scholarship.description && (
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold text-white font-display">Complete Description</h2>
              <p className="text-sm text-slate-300 leading-relaxed">{scholarship.description}</p>
            </div>
          )}

          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold text-white font-display">Financial Benefits</h2>
            <p className="text-sm text-slate-300 leading-relaxed">
              {scholarship.financialBenefitsText || scholarship.benefitsSummary}
            </p>
          </div>

          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-white font-display">Eligibility Requirements</h2>
            <p className="text-sm text-slate-300 leading-relaxed">{scholarship.eligibilitySummary}</p>
            {scholarship.academicRequirements && (
              <p className="text-xs text-slate-300">
                <span className="font-semibold text-white">Academic Requirement:</span> {scholarship.academicRequirements}
              </p>
            )}
            <div className="grid sm:grid-cols-3 gap-3 pt-2 text-xs text-slate-300">
              <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800">
                <span className="font-semibold text-white block mb-0.5">Education Levels</span>
                <span>{(scholarship.educationLevels ?? []).join(', ') || 'See official portal'}</span>
              </div>
              <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800">
                <span className="font-semibold text-white block mb-0.5">Eligible Courses</span>
                <span>{(scholarship.eligibleCourses ?? []).join(', ') || 'See official portal'}</span>
              </div>
              <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800">
                <span className="font-semibold text-white block mb-0.5">State &amp; Category Scope</span>
                <span>
                  {(scholarship.eligibleStates ?? ['All India']).join(', ')} ·{' '}
                  {(scholarship.allowedCategories ?? ['All']).join(', ')}
                </span>
              </div>
            </div>
          </div>

          {scholarship.applicationProcess && (
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold text-white font-display">Official Application Process</h2>
              <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                {scholarship.applicationProcess}
              </p>
            </div>
          )}

          {/* Source & Verification */}
          <div className="pt-4 border-t border-slate-800 space-y-2 text-xs text-slate-400">
            <div className="flex items-center gap-1.5 font-semibold text-white">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Source &amp; Verification Information</span>
            </div>
            <p>
              Verification Status: <strong className="text-white">{scholarship.verificationStatus}</strong> · Last Verified:{' '}
              <span className="font-mono-num text-slate-300">{scholarship.lastVerifiedDate || 'Needs verification'}</span>
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <a
                href={scholarship.officialUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-300 hover:underline inline-flex items-center gap-1 break-all"
              >
                <span>Official Application URL: {scholarship.officialUrl}</span>
                <ExternalLink className="w-3 h-3 shrink-0" />
              </a>
              {scholarship.officialSourceUrl && (
                <a
                  href={scholarship.officialSourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-300 hover:underline inline-flex items-center gap-1 break-all"
                >
                  <span>Official Source URL: {scholarship.officialSourceUrl}</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              )}
            </div>
            {scholarship.sourceNotes && <p className="text-slate-400">{scholarship.sourceNotes}</p>}
            <p className="text-slate-300 pt-1">
              {scholarship.id === 'jharkhand-ekalyan-post-matric'
                ? 'Scholarship information is provided for guidance. Final eligibility and application approval are determined by the official E-Kalyan portal and concerned authorities.'
                : 'Scholarship information is provided for guidance. Final eligibility and application approval are determined by the official scholarship portal and concerned authorities.'}
            </p>
          </div>
        </div>

        {/* Criteria Breakdown + Documents Checklist */}
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="surface-card rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white font-display">
                  Your Eligibility Breakdown
                </h2>
                {eligibility && (
                  <p className="text-xs text-slate-400 mt-0.5">
                    <span
                      className={
                        eligibility.overallStatus === 'Eligible'
                          ? 'text-emerald-400 font-semibold'
                          : eligibility.overallStatus === 'Potentially Eligible'
                            ? 'text-amber-300 font-semibold'
                            : eligibility.overallStatus === 'Not Eligible'
                              ? 'text-rose-400 font-semibold'
                              : 'text-slate-200 font-semibold'
                      }
                    >
                      {eligibility.overallStatus}
                    </span>{' '}
                    ·{' '}
                    <span className="font-mono-num">
                      {eligibility.compatibilityScore}% compatibility
                    </span>
                  </p>
                )}
              </div>
              <Link
                to={`/eligibility?scholarshipId=${scholarship.id}`}
                className="text-xs font-semibold text-indigo-300 hover:underline whitespace-nowrap"
              >
                Full Audit &amp; AI →
              </Link>
            </div>
            <div className="space-y-3">
              {eligibility?.criteriaBreakdown.map((c) => (
                <div key={c.criterion} className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-1">
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className="text-white">{c.criterion}</span>
                    <span
                      className={
                        c.status === 'Passed'
                          ? 'text-emerald-400'
                          : c.status === 'Failed'
                            ? 'text-rose-400'
                            : c.status === 'Unknown'
                              ? 'text-amber-300'
                              : 'text-slate-400'
                      }
                    >
                      {c.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400">{c.detail}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="surface-card rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white font-display">
                Required Documents Checklist
              </h2>
              <Link to="/documents" className="text-xs font-semibold text-indigo-300 hover:underline">
                Upload &amp; Verify →
              </Link>
            </div>
            <div className="space-y-2.5">
              {(scholarship.requiredDocuments ?? []).map((docName) => {
                const isHeld = heldSet.has(docName.toLowerCase());
                return (
                  <div
                    key={docName}
                    className="flex items-center justify-between p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-sm"
                  >
                    <span className="text-slate-200">{docName}</span>
                    {isHeld ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>In Profile</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-300">
                        <XCircle className="w-4 h-4" />
                        <span>Not Marked</span>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </PageTransition>
    </AppShell>
  );
}
