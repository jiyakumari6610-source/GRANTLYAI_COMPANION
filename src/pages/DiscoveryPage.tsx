import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  Bookmark,
  ClipboardCheck,
  Database,
  ExternalLink,
  RotateCcw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import { PageTransition, SkeletonCard } from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { postProtectedAi } from '../lib/apiClient.ts';
import {
  findDuplicateActiveApplication,
  normalizeApplicationStatus,
} from '../lib/applicationTrackerEngine.ts';
import {
  evaluateDeterministicEligibility,
  type EligibilityEvaluationResult,
} from '../lib/eligibilityEngine.ts';
import { peekPublicCache, peekUserCache } from '../lib/workspaceCache.ts';
import {
  getApplications,
  getSavedScholarships,
  getScholarships,
  seedVerifiedScholarships,
  toggleSavedScholarship,
} from '../lib/firestoreRepo.ts';
import {
  DEFAULT_DISCOVERY_FILTERS,
  filterAndSortScholarships,
  type DiscoveryFilters,
  type SortOption,
} from '../lib/scholarshipEngine.ts';
import {
  INDIAN_STATES_AND_UTS,
  type ApplicationRecord,
  type SavedScholarship,
  type Scholarship,
} from '../types/database.ts';

const SCHOLARSHIP_CATEGORIES = [
  'All',
  'Central Government',
  'State Government',
  'Private',
  'Corporate',
  'University',
  'Merit-Based',
  'Need-Based',
  'Category-Based',
] as const;

const EDUCATION_LEVELS = [
  'All',
  'Class 11-12',
  'Diploma / Polytechnic',
  'Undergraduate (UG)',
  'Postgraduate (PG)',
  'PhD / Doctoral',
] as const;

const SOCIAL_CATEGORIES = ['All', 'General', 'OBC-NCL', 'SC', 'ST', 'EWS', 'Minority'] as const;

const APPLICATION_STATUS_FILTERS = [
  'All',
  'Currently accepting applications',
  'Upcoming',
  'Status unknown',
  'Closed',
  'Expired',
] as const;

const PAGE_SIZE = 8;

interface DiscoveryScholarshipCardProps {
  scholarship: Scholarship;
  effectiveStatus: string;
  isSaved: boolean;
  eligibility: EligibilityEvaluationResult;
  activeTracked: ApplicationRecord | undefined;
  isTrackingBusy: boolean;
  onToggleSave: (id: string) => void;
  onTrack: (id: string) => void;
}

const DiscoveryScholarshipCard = memo(function DiscoveryScholarshipCard({
  scholarship,
  effectiveStatus,
  isSaved,
  eligibility,
  activeTracked,
  isTrackingBusy,
  onToggleSave,
  onTrack,
}: DiscoveryScholarshipCardProps) {
  const isInactive = effectiveStatus === 'Expired' || effectiveStatus === 'Closed';

  return (
    <article
      className={`surface-card surface-interactive rounded-2xl p-6 flex flex-col justify-between gap-5 ${
        isInactive ? 'opacity-80' : ''
      }`}
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-400">
            <span className="font-medium text-slate-200">{scholarship.scholarshipType}</span>
            <span aria-hidden="true">·</span>
            <span
              className={
                scholarship.verificationStatus === 'Verified' ||
                scholarship.verificationStatus === 'Verified Official Source'
                  ? 'text-emerald-400 font-medium'
                  : 'text-amber-300 font-medium'
              }
            >
              {scholarship.verificationStatus}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={
                effectiveStatus === 'Currently accepting applications'
                  ? 'text-emerald-400 font-medium'
                  : isInactive
                    ? 'text-rose-400 font-semibold'
                    : 'text-slate-300'
              }
            >
              {effectiveStatus}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onToggleSave(scholarship.id)}
            aria-label={isSaved ? 'Unsave scholarship' : 'Save scholarship'}
            className={`p-1.5 rounded-lg border shrink-0 transition-colors ${
              isSaved
                ? 'bg-indigo-500/20 border-indigo-400/40 text-indigo-300'
                : 'bg-slate-900/70 border-slate-700 text-slate-400 hover:text-white'
            }`}
          >
            <Bookmark className="w-4 h-4" fill={isSaved ? 'currentColor' : 'none'} />
          </button>
        </div>

        <div>
          <Link
            to={`/scholarships/${scholarship.id}`}
            className="text-base font-semibold text-white hover:text-indigo-300 leading-snug font-display transition-colors"
          >
            {scholarship.title}
          </Link>
          <p className="text-xs text-slate-400 mt-1">{scholarship.provider}</p>
        </div>

        <p className="text-sm text-slate-300 leading-relaxed line-clamp-3">
          {scholarship.financialBenefitsText || scholarship.benefitsSummary || scholarship.description}
        </p>

        <div className="text-xs text-slate-400 flex flex-wrap gap-x-3 gap-y-1">
          <span>
            Income Cap:{' '}
            <strong className="font-mono-num text-slate-200">
              {typeof scholarship.incomeLimitInr === 'number'
                ? `₹${scholarship.incomeLimitInr.toLocaleString('en-IN')}`
                : 'None specified'}
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Profile Match:{' '}
            <strong
              className={
                eligibility.overallStatus === 'Eligible'
                  ? 'text-emerald-400'
                  : eligibility.overallStatus === 'Potentially Eligible'
                    ? 'text-amber-300'
                    : eligibility.overallStatus === 'Insufficient Information'
                      ? 'text-slate-200'
                      : eligibility.overallStatus === 'Scholarship Status Unverified'
                        ? 'text-amber-300'
                        : 'text-rose-400'
              }
            >
              {eligibility.overallStatus}
            </strong>{' '}
            <span className="font-mono-num text-slate-400">({eligibility.compatibilityScore}%)</span>
          </span>
        </div>
      </div>

      <div className="pt-4 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="min-w-0">
          <span className="font-mono-num font-semibold text-indigo-200">
            {scholarship.annualAwardInr
              ? `₹${scholarship.annualAwardInr.toLocaleString('en-IN')}/yr`
              : 'Variable Grant'}
          </span>
          <span className="text-slate-600 mx-1.5">·</span>
          <span className="text-slate-400">
            Deadline: {scholarship.applicationDeadline || 'Check Official Portal'}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {activeTracked ? (
            <Link
              to={`/applications/${activeTracked.id}`}
              className="font-semibold text-emerald-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              <span>Tracked ({normalizeApplicationStatus(activeTracked.status)})</span>
            </Link>
          ) : (
            <button
              type="button"
              disabled={isTrackingBusy}
              onClick={() => onTrack(scholarship.id)}
              className="font-semibold text-slate-200 hover:text-indigo-300 inline-flex items-center gap-1 whitespace-nowrap disabled:opacity-50"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              <span>{isTrackingBusy ? 'Adding...' : 'Track'}</span>
            </button>
          )}
          <Link
            to={`/scholarships/${scholarship.id}`}
            className="font-semibold text-slate-300 hover:text-white whitespace-nowrap"
          >
            Details
          </Link>
          <a
            href={scholarship.officialUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-indigo-300 hover:text-indigo-200 hover:underline inline-flex items-center gap-1 whitespace-nowrap"
          >
            <span>Apply Now</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    </article>
  );
});

export default function DiscoveryPage() {
  const { user, profile, isAdmin, getIdToken } = useAuth();
  const navigate = useNavigate();
  const cachedSch = peekPublicCache<{ items: Scholarship[]; isEmptyDatabase: boolean }>('scholarships');
  const cachedSaved = peekUserCache<SavedScholarship[]>(user?.uid, 'saved_scholarships');
  const cachedApps = peekUserCache<ApplicationRecord[]>(user?.uid, 'applications');
  const hasWarmCache = Boolean(cachedSch && (!user || (cachedSaved && cachedApps)));

  const [scholarships, setScholarships] = useState<Scholarship[]>(() => cachedSch?.items ?? []);
  const [saved, setSaved] = useState<SavedScholarship[]>(() => cachedSaved ?? []);
  const [applications, setApplications] = useState<ApplicationRecord[]>(() => cachedApps ?? []);
  const [trackingBusyId, setTrackingBusyId] = useState<string | null>(null);
  const [isEmptyDatabase, setIsEmptyDatabase] = useState<boolean>(
    () => cachedSch?.isEmptyDatabase ?? false
  );
  const [loading, setLoading] = useState(!hasWarmCache);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(true);

  const [filters, setFilters] = useState<DiscoveryFilters>(DEFAULT_DISCOVERY_FILTERS);
  const [sortBy, setSortBy] = useState<SortOption>('relevant');
  const [page, setPage] = useState(1);

  const fetchDiscoveryData = useCallback(async () => {
    setError(null);
    const [schRes, savedItems, appsItems] = await Promise.all([
      getScholarships(),
      user ? getSavedScholarships(user.uid) : Promise.resolve([]),
      user ? getApplications(user.uid) : Promise.resolve([]),
    ]);
    setScholarships(schRes.items);
    setIsEmptyDatabase(schRes.isEmptyDatabase);
    setSaved(savedItems);
    setApplications(appsItems);
  }, [user]);

  useEffect(() => {
    let active = true;
    fetchDiscoveryData()
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unable to query scholarship database.');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchDiscoveryData]);

  const savedMap = useMemo(() => {
    const map = new Map<string, string>();
    saved.forEach((item) => map.set(item.scholarshipId, item.id));
    return map;
  }, [saved]);

  const savedIdSet = useMemo(() => new Set(savedMap.keys()), [savedMap]);

  const eligibilityMap = useMemo(() => {
    const map = new Map<string, EligibilityEvaluationResult>();
    for (const s of scholarships) {
      map.set(s.id, evaluateDeterministicEligibility(profile, s));
    }
    return map;
  }, [scholarships, profile]);

  const activeTrackedMap = useMemo(() => {
    const map = new Map<string, ApplicationRecord | undefined>();
    for (const s of scholarships) {
      map.set(s.id, findDuplicateActiveApplication(applications, s.id) ?? undefined);
    }
    return map;
  }, [scholarships, applications]);

  const results = useMemo(
    () => filterAndSortScholarships(scholarships, filters, sortBy, profile, savedIdSet),
    [scholarships, filters, sortBy, profile, savedIdSet]
  );

  const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedResults = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return results.slice(start, start + PAGE_SIZE);
  }, [results, currentPage]);

  useEffect(() => {
    setPage(1);
  }, [filters, sortBy]);

  const handleToggleSave = useCallback(
    async (scholarshipId: string) => {
      if (!user) return;
      const existingId = savedMap.get(scholarshipId);
      await toggleSavedScholarship(user.uid, scholarshipId, existingId);
      const updated = await getSavedScholarships(user.uid);
      setSaved(updated);
    },
    [user, savedMap]
  );

  const handleTrackFromDiscovery = useCallback(
    async (scholarshipId: string) => {
      if (!user) return;
      const activeApp = activeTrackedMap.get(scholarshipId);
      if (activeApp) {
        navigate(`/applications/${activeApp.id}`);
        return;
      }
      setTrackingBusyId(scholarshipId);
      setError(null);
      try {
        const token = await getIdToken();
        const res = await postProtectedAi<{ application: ApplicationRecord }>(
          '/api/applications',
          token,
          { scholarshipId, initialStatus: 'Interested' }
        );
        setApplications((prev) => [res.application, ...prev]);
        navigate(`/applications/${res.application.id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to add scholarship to tracker.');
      } finally {
        setTrackingBusyId(null);
      }
    },
    [user, activeTrackedMap, getIdToken, navigate]
  );

  const handleAdminSyncNow = async () => {
    if (!isAdmin) return;
    setSyncing(true);
    setError(null);
    try {
      await seedVerifiedScholarships();
      await fetchDiscoveryData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to refresh the scholarship catalog.');
    } finally {
      setSyncing(false);
    }
  };

  const resetFilters = () => {
    setFilters(DEFAULT_DISCOVERY_FILTERS);
    setSortBy('relevant');
    setPage(1);
  };

  return (
    <AppShell
      title="Scholarship Discovery"
      breadcrumb="Workspace / Real Scholarship Intelligence Engine"
      primaryAction={
        <button
          type="button"
          onClick={() => setShowAdvancedFilters((v) => !v)}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-200 bg-slate-900/90 border border-slate-700 hover:border-indigo-400/50 rounded-xl whitespace-nowrap transition-colors"
        >
          <SlidersHorizontal className="w-4 h-4 text-indigo-300" />
          <span>{showAdvancedFilters ? 'Hide Filters' : 'Show Filters'}</span>
        </button>
      }
    >
      <PageTransition className="space-y-6">
        {error && (
          <div className="p-4 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-sm text-rose-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void fetchDiscoveryData()
                  .catch((err) =>
                    setError(err instanceof Error ? err.message : 'Unable to query scholarship database.')
                  )
                  .finally(() => setLoading(false));
              }}
              className="px-3 py-1.5 text-xs font-semibold text-rose-100 bg-rose-500/25 hover:bg-rose-500/35 border border-rose-400/30 rounded-lg whitespace-nowrap"
            >
              Retry
            </button>
          </div>
        )}

        {/* Search, Sort & Category Bar */}
        <div className="surface-card rounded-2xl p-5 space-y-4">
          <div className="grid md:grid-cols-12 gap-3">
            <div className="md:col-span-6 relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={filters.queryText}
                onChange={(e) => setFilters({ ...filters, queryText: e.target.value })}
                placeholder="Search by scheme name, provider, course, or keyword..."
                className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl input-midnight"
              />
            </div>

            <div className="md:col-span-3">
              <select
                aria-label="Sort scholarships"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
              >
                <option value="relevant">Sort: Most Relevant</option>
                <option value="benefit_desc">Sort: Highest Financial Benefit</option>
                <option value="deadline_asc">Sort: Nearest Deadline</option>
                <option value="recently_verified">Sort: Recently Verified</option>
              </select>
            </div>

            <div className="md:col-span-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFilters({ ...filters, onlySaved: !filters.onlySaved })}
                className={`flex-1 px-3 py-2.5 text-xs font-medium rounded-xl border transition-colors whitespace-nowrap ${
                  filters.onlySaved
                    ? 'bg-indigo-500/20 border-indigo-400/50 text-indigo-200'
                    : 'bg-slate-900/70 border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                Saved ({saved.length})
              </button>
              <button
                type="button"
                onClick={resetFilters}
                title="Reset all filters"
                className="px-3 py-2.5 text-xs font-medium rounded-xl border border-slate-700 bg-slate-900/70 text-slate-300 hover:bg-slate-800 inline-flex items-center gap-1 whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            </div>
          </div>

          {/* 8 Category Tabs */}
          <div className="flex flex-wrap gap-1.5">
            {SCHOLARSHIP_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setFilters({ ...filters, scholarshipType: cat })}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap border ${
                  filters.scholarshipType === cat
                    ? 'bg-indigo-600 text-white border-indigo-500'
                    : 'bg-slate-900/60 text-slate-300 border-slate-800 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Advanced Multi-Facet Filters */}
          <AnimatePresence initial={false}>
            {showAdvancedFilters && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="pt-4 border-t border-slate-800 grid sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Education Level</label>
                    <select
                      value={filters.educationLevel}
                      onChange={(e) => setFilters({ ...filters, educationLevel: e.target.value })}
                      className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl input-midnight"
                    >
                      {EDUCATION_LEVELS.map((lvl) => (
                        <option key={lvl} value={lvl}>
                          {lvl}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Course / Stream</label>
                    <input
                      type="text"
                      value={filters.course}
                      onChange={(e) => setFilters({ ...filters, course: e.target.value })}
                      placeholder="e.g. Engineering, B.Sc, Medical"
                      className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl input-midnight"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Domicile State</label>
                    <select
                      value={filters.state}
                      onChange={(e) => setFilters({ ...filters, state: e.target.value })}
                      className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl input-midnight"
                    >
                      <option value="All">All States &amp; UTs</option>
                      {INDIAN_STATES_AND_UTS.map((st) => (
                        <option key={st} value={st}>
                          {st}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Social Category</label>
                    <select
                      value={filters.category}
                      onChange={(e) => setFilters({ ...filters, category: e.target.value })}
                      className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl input-midnight"
                    >
                      {SOCIAL_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-slate-400">
                        Your Annual Family Income (INR)
                      </label>
                      {typeof profile?.familyAnnualIncomeInr === 'number' && (
                        <button
                          type="button"
                          onClick={() =>
                            setFilters({ ...filters, maxFamilyIncomeInr: profile.familyAnnualIncomeInr ?? null })
                          }
                          className="text-[11px] font-medium text-indigo-300 hover:underline"
                        >
                          Use profile
                        </button>
                      )}
                    </div>
                    <input
                      type="number"
                      min="0"
                      value={filters.maxFamilyIncomeInr ?? ''}
                      onChange={(e) =>
                        setFilters({
                          ...filters,
                          maxFamilyIncomeInr: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      placeholder="e.g. 250000"
                      className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl input-midnight font-mono-num"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Gender Eligibility</label>
                    <select
                      value={filters.gender}
                      onChange={(e) => setFilters({ ...filters, gender: e.target.value })}
                      className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl input-midnight"
                    >
                      <option value="All">All Genders</option>
                      <option value="Female">Female</option>
                      <option value="Male">Male</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Application Status / Deadline
                    </label>
                    <select
                      value={filters.applicationStatusFilter}
                      onChange={(e) =>
                        setFilters({ ...filters, applicationStatusFilter: e.target.value })
                      }
                      className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl input-midnight"
                    >
                      {APPLICATION_STATUS_FILTERS.map((st) => (
                        <option key={st} value={st}>
                          {st}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Minimum Financial Benefit
                    </label>
                    <select
                      value={filters.minBenefitInr ?? 0}
                      onChange={(e) =>
                        setFilters({
                          ...filters,
                          minBenefitInr: Number(e.target.value) || null,
                        })
                      }
                      className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl input-midnight font-mono-num"
                    >
                      <option value={0}>Any Amount</option>
                      <option value={15000}>₹15,000+ / year</option>
                      <option value={25000}>₹25,000+ / year</option>
                      <option value={50000}>₹50,000+ / year</option>
                    </select>
                  </div>

                  <div className="sm:col-span-2 lg:col-span-4 flex flex-wrap items-center justify-between gap-2 pt-1">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={filters.includeExpiredOrClosed}
                        onChange={(e) =>
                          setFilters({ ...filters, includeExpiredOrClosed: e.target.checked })
                        }
                        className="rounded border-slate-600 bg-slate-900 text-indigo-500"
                      />
                      <span>Show Expired &amp; Closed scholarships in results</span>
                    </label>

                    <span className="text-xs text-slate-400 font-mono-num">
                      {loading ? 'Loading...' : `${results.length} matching records`}
                    </span>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Loading, Empty Database, or Results */}
        {loading ? (
          <div className="grid md:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((n) => (
              <SkeletonCard key={n} className="h-56" />
            ))}
          </div>
        ) : isEmptyDatabase ? (
          <div className="surface-card rounded-2xl p-10 text-center space-y-4">
            <Database className="w-8 h-8 text-slate-400 mx-auto" />
            <div className="space-y-1 max-w-md mx-auto">
              <p className="text-base font-semibold text-white">
                Scholarship catalog is currently updating
              </p>
              <p className="text-xs sm:text-sm text-slate-400">
                No verified scholarship records are published yet. Please check back shortly or contact your administrator if you manage this catalog.
              </p>
            </div>
            {isAdmin && (
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={syncing}
                  onClick={() => void handleAdminSyncNow()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold btn-primary-gradient rounded-xl disabled:opacity-60"
                >
                  <Database className="w-3.5 h-3.5" />
                  <span>{syncing ? 'Publishing Verified Schemes...' : 'Publish 16 Verified Schemes Now'}</span>
                </button>
                <Link
                  to="/admin"
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-xl"
                >
                  <span>Open Admin Dashboard</span>
                </Link>
              </div>
            )}
          </div>
        ) : results.length === 0 ? (
          <div className="surface-card rounded-2xl p-10 text-center space-y-3">
            <p className="text-sm font-semibold text-white">
              No scholarships match your selected filters
            </p>
            <p className="text-xs text-slate-400">
              Adjust your income ceiling, state, category, or course keyword, or reset filters.
            </p>
            <button
              type="button"
              onClick={resetFilters}
              className="px-4 py-2 text-xs font-semibold text-indigo-200 bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/30 rounded-xl"
            >
              Reset All Filters
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid md:grid-cols-2 gap-5">
              {paginatedResults.map(({ scholarship, effectiveStatus }) => (
                <DiscoveryScholarshipCard
                  key={scholarship.id}
                  scholarship={scholarship}
                  effectiveStatus={effectiveStatus}
                  isSaved={savedMap.has(scholarship.id)}
                  eligibility={
                    eligibilityMap.get(scholarship.id) ??
                    evaluateDeterministicEligibility(profile, scholarship)
                  }
                  activeTracked={activeTrackedMap.get(scholarship.id)}
                  isTrackingBusy={trackingBusyId === scholarship.id}
                  onToggleSave={(id) => void handleToggleSave(id)}
                  onTrack={(id) => void handleTrackFromDiscovery(id)}
                />
              ))}
            </div>

            {totalPages > 1 && (
              <div className="surface-card rounded-2xl px-5 py-3.5 flex items-center justify-between text-xs text-slate-400">
                <span className="font-mono-num">
                  Page {currentPage} of {totalPages} · Showing {(currentPage - 1) * PAGE_SIZE + 1}–
                  {Math.min(currentPage * PAGE_SIZE, results.length)} of {results.length}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="px-3 py-1.5 font-medium border border-slate-700 bg-slate-900/70 text-slate-200 rounded-lg hover:bg-slate-800 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="px-3 py-1.5 font-medium border border-slate-700 bg-slate-900/70 text-slate-200 rounded-lg hover:bg-slate-800 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </PageTransition>
    </AppShell>
  );
}
