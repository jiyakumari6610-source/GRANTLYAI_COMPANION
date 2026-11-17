import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Database,
  Edit3,
  ExternalLink,
  FileCheck2,
  Globe,
  History,
  Layers,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { SkeletonCard } from '../ui/MotionPrimitives.tsx';
import {
  ALLOWED_RULE_KEYS,
  PHASE9_VERIFICATION_STATUSES,
  detectRuleContradictions,
  normalizeVerificationStatus,
  type RuleDraftInput,
} from '../../lib/adminGovernanceEngine.ts';
import { getProtectedApi, patchProtectedApi, postProtectedAi, putProtectedApi } from '../../lib/apiClient.ts';
import { getEffectiveApplicationStatus } from '../../lib/scholarshipEngine.ts';
import {
  INDIAN_STATES_AND_UTS,
  type ApplicationCycleStatus,
  type DataQualityIssueRecord,
  type DataQualityResolutionStatus,
  type EligibilityRuleOperator,
  type Scholarship,
  type ScholarshipEligibilityRule,
  type ScholarshipRuleVersionRecord,
  type ScholarshipType,
  type ScholarshipVerificationHistoryRecord,
  type VerificationStatus,
} from '../../types/database.ts';

const ALL_TYPES: ScholarshipType[] = [
  'Central Government',
  'State Government',
  'Private',
  'Corporate',
  'University',
  'Merit-Based',
  'Need-Based',
  'Category-Based',
];

const APPLICATION_STATUSES: ApplicationCycleStatus[] = [
  'Currently accepting applications',
  'Upcoming',
  'Closed',
  'Expired',
  'Status unknown',
];

function statusTextColor(status: VerificationStatus): string {
  const norm = normalizeVerificationStatus(status);
  switch (norm) {
    case 'Verified':
      return 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30';
    case 'Pending Review':
      return 'text-amber-300 bg-amber-500/10 border-amber-500/30';
    case 'Needs Correction':
      return 'text-rose-300 bg-rose-500/10 border-rose-500/30';
    case 'Expired':
      return 'text-orange-300 bg-orange-500/10 border-orange-500/30';
    case 'Archived':
      return 'text-slate-300 bg-slate-800/70 border-slate-700';
    default:
      return 'text-slate-300 bg-slate-800/60 border-slate-700/80';
  }
}

function severityBadgeClass(sev: DataQualityIssueRecord['severity']): string {
  switch (sev) {
    case 'Critical':
      return 'text-rose-300 bg-rose-500/10 border-rose-500/30';
    case 'High':
      return 'text-orange-300 bg-orange-500/10 border-orange-500/30';
    case 'Medium':
      return 'text-amber-300 bg-amber-500/10 border-amber-500/30';
    default:
      return 'text-slate-300 bg-slate-800/70 border-slate-700';
  }
}

// ============================================================================
// 1. Scholarship Management Panel (CRUD, Search, Filters, Sort, Pagination, Archive)
// ============================================================================

export function AdminScholarshipsPanel({
  scholarships,
  getIdToken,
  onReload,
  onNotify,
  onOpenVerification,
  onOpenRules,
}: {
  scholarships: Scholarship[];
  getIdToken: () => Promise<string>;
  onReload: () => Promise<void>;
  onNotify: (msg: string | null, err?: string | null) => void;
  onOpenVerification: (scholarshipId: string) => void;
  onOpenRules: (scholarshipId: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('ALL');
  const [filterState, setFilterState] = useState<string>('ALL');
  const [filterEduLevel] = useState<string>('ALL');
  const [filterVerification, setFilterVerification] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<'updated' | 'deadline' | 'award' | 'title'>('updated');
  const [page, setPage] = useState(1);
  const pageSize = 8;

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Scholarship | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [archiving, setArchiving] = useState(false);

  // Form fields
  const [title, setTitle] = useState('');
  const [provider, setProvider] = useState('');
  const [scholarshipType, setScholarshipType] = useState<ScholarshipType>('Central Government');
  const [description, setDescription] = useState('');
  const [financialBenefitsText, setFinancialBenefitsText] = useState('');
  const [annualAwardInr, setAnnualAwardInr] = useState('');
  const [minIncomeLimitInr, setMinIncomeLimitInr] = useState('');
  const [incomeLimitInr, setIncomeLimitInr] = useState('');
  const [minMarksPercent, setMinMarksPercent] = useState('');
  const [academicRequirements, setAcademicRequirements] = useState('');
  const [educationLevelsText, setEducationLevelsText] = useState('Undergraduate (UG)');
  const [eligibleCoursesText, setEligibleCoursesText] = useState('All Regular Streams');
  const [eligibleStatesText, setEligibleStatesText] = useState('All India');
  const [allowedCategoriesText, setAllowedCategoriesText] = useState(
    'General, OBC-NCL, SC, ST, EWS, Minority'
  );
  const [genderRestriction, setGenderRestriction] = useState<'All' | 'Female' | 'Male'>('All');
  const [applicationStartDate, setApplicationStartDate] = useState('Check Official Portal');
  const [applicationDeadline, setApplicationDeadline] = useState('Check Official Portal');
  const [applicationProcess, setApplicationProcess] = useState('');
  const [officialUrl, setOfficialUrl] = useState('https://scholarships.gov.in/');
  const [officialSourceUrl, setOfficialSourceUrl] = useState('https://scholarships.gov.in/');
  const [sourceName, setSourceName] = useState('');
  const [applicationStatus, setApplicationStatus] = useState<ApplicationCycleStatus>('Status unknown');

  const resetForm = () => {
    setEditingId(null);
    setTitle('');
    setProvider('');
    setScholarshipType('Central Government');
    setDescription('');
    setFinancialBenefitsText('');
    setAnnualAwardInr('');
    setMinIncomeLimitInr('');
    setIncomeLimitInr('');
    setMinMarksPercent('');
    setAcademicRequirements('');
    setEducationLevelsText('Undergraduate (UG)');
    setEligibleCoursesText('All Regular Streams');
    setEligibleStatesText('All India');
    setAllowedCategoriesText('General, OBC-NCL, SC, ST, EWS, Minority');
    setGenderRestriction('All');
    setApplicationStartDate('Check Official Portal');
    setApplicationDeadline('Check Official Portal');
    setApplicationProcess('');
    setOfficialUrl('https://scholarships.gov.in/');
    setOfficialSourceUrl('https://scholarships.gov.in/');
    setSourceName('');
    setApplicationStatus('Status unknown');
  };

  const startEdit = (item: Scholarship) => {
    setEditingId(item.id);
    setTitle(item.title);
    setProvider(item.provider);
    setScholarshipType(item.scholarshipType === 'Private Foundation' ? 'Private' : item.scholarshipType);
    setDescription(item.description || '');
    setFinancialBenefitsText(item.financialBenefitsText || item.benefitsSummary || '');
    setAnnualAwardInr(item.annualAwardInr ? String(item.annualAwardInr) : '');
    setMinIncomeLimitInr(typeof item.minIncomeLimitInr === 'number' ? String(item.minIncomeLimitInr) : '');
    setIncomeLimitInr(typeof item.incomeLimitInr === 'number' ? String(item.incomeLimitInr) : '');
    setMinMarksPercent(typeof item.minMarksPercent === 'number' ? String(item.minMarksPercent) : '');
    setAcademicRequirements(item.academicRequirements || '');
    setEducationLevelsText((item.educationLevels ?? ['Undergraduate (UG)']).join(', '));
    setEligibleCoursesText((item.eligibleCourses ?? ['All Regular Streams']).join(', '));
    setEligibleStatesText((item.eligibleStates ?? ['All India']).join(', '));
    setAllowedCategoriesText(
      (item.allowedCategories ?? ['General', 'OBC-NCL', 'SC', 'ST', 'EWS', 'Minority']).join(', ')
    );
    setGenderRestriction(item.genderRestriction ?? 'All');
    setApplicationStartDate(item.applicationStartDate || 'Check Official Portal');
    setApplicationDeadline(item.applicationDeadline || 'Check Official Portal');
    setApplicationProcess(item.applicationProcess || '');
    setOfficialUrl(item.officialUrl);
    setOfficialSourceUrl(item.officialSourceUrl || item.officialUrl);
    setSourceName(item.sourceName || item.provider);
    setApplicationStatus(item.applicationStatus || 'Status unknown');
    setShowForm(true);
  };

  const handleSeedCatalog = async () => {
    setSeeding(true);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{ count: number }>('/api/admin/scholarships/seed', token, {});
      await onReload();
      onNotify(`Synced ${res.count} verified Indian scholarship schemes into Firestore and recorded an audit entry.`, null);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to sync catalog.');
    } finally {
      setSeeding(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      const existing = editingId ? scholarships.find((s) => s.id === editingId) : null;
      const payload = {
        ...(editingId ? { id: editingId } : {}),
        title: title.trim(),
        provider: provider.trim(),
        scholarshipType,
        description: description.trim(),
        benefitsSummary: financialBenefitsText.trim(),
        financialBenefitsText: financialBenefitsText.trim(),
        annualAwardInr: annualAwardInr ? Number(annualAwardInr) : null,
        academicRequirements: academicRequirements.trim(),
        minIncomeLimitInr: minIncomeLimitInr ? Number(minIncomeLimitInr) : null,
        incomeLimitInr: incomeLimitInr ? Number(incomeLimitInr) : null,
        minMarksPercent: minMarksPercent ? Number(minMarksPercent) : null,
        educationLevels: educationLevelsText.split(',').map((s) => s.trim()).filter(Boolean),
        eligibleCourses: eligibleCoursesText.split(',').map((s) => s.trim()).filter(Boolean),
        eligibleStates: eligibleStatesText.split(',').map((s) => s.trim()).filter(Boolean),
        allowedCategories: allowedCategoriesText.split(',').map((s) => s.trim()).filter(Boolean),
        genderRestriction,
        applicationStartDate: applicationStartDate.trim() || 'Check Official Portal',
        applicationDeadline: applicationDeadline.trim() || 'Check Official Portal',
        applicationProcess: applicationProcess.trim(),
        applicationStatus,
        officialUrl: officialUrl.trim(),
        officialSourceUrl: officialSourceUrl.trim() || officialUrl.trim(),
        sourceName: sourceName.trim() || provider.trim(),
        verificationStatus: existing?.verificationStatus ?? 'Pending Review',
      };

      if (editingId) {
        await putProtectedApi(`/api/admin/scholarships/${editingId}`, token, payload);
        onNotify(`Updated "${payload.title}" and logged change to immutable audit trail.`, null);
      } else {
        await postProtectedAi('/api/admin/scholarships', token, payload);
        onNotify(
          `Created "${payload.title}" in Pending Review status. Complete verification in the Verification Queue before marking Verified.`,
          null
        );
      }
      resetForm();
      setShowForm(false);
      await onReload();
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to save scholarship.');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmArchive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      await postProtectedAi(`/api/admin/scholarships/${archiveTarget.id}/archive`, token, {
        reason: archiveReason.trim() || 'Archived by administrator while preserving existing student links.',
      });
      onNotify(`Archived "${archiveTarget.title}". Existing student application links remain intact.`, null);
      setArchiveTarget(null);
      setArchiveReason('');
      await onReload();
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to archive scholarship.');
    } finally {
      setArchiving(false);
    }
  };

  const filteredScholarships = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return scholarships
      .filter((s) => {
        if (q) {
          const hay = `${s.title} ${s.provider} ${s.id} ${(s.eligibleStates ?? []).join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (filterType !== 'ALL' && s.scholarshipType !== filterType) return false;
        if (filterState !== 'ALL') {
          const states = s.eligibleStates ?? [];
          if (!states.includes('All India') && !states.includes(filterState)) return false;
        }
        if (filterEduLevel !== 'ALL') {
          const levels = s.educationLevels ?? [];
          if (!levels.includes(filterEduLevel)) return false;
        }
        if (filterVerification !== 'ALL') {
          if (normalizeVerificationStatus(s.verificationStatus) !== filterVerification) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'title') return a.title.localeCompare(b.title);
        if (sortBy === 'award') return (b.annualAwardInr ?? 0) - (a.annualAwardInr ?? 0);
        if (sortBy === 'deadline') {
          return (a.applicationDeadline || '9999').localeCompare(b.applicationDeadline || '9999');
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [scholarships, searchQuery, filterType, filterState, filterEduLevel, filterVerification, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filteredScholarships.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedRows = filteredScholarships.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, filterType, filterState, filterEduLevel, filterVerification, sortBy]);

  return (
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="surface-card rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white font-display">
            Scholarship Registry Governance (<span className="font-mono-num">{scholarships.length}</span>)
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            New schemes enter as Pending Review until human-verified. Archiving preserves historical student applications.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void handleSeedCatalog()}
            disabled={seeding}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-xl transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            <Database className="w-3.5 h-3.5 text-indigo-400" />
            <span>{seeding ? 'Syncing...' : 'Sync 16 Official Schemes'}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              resetForm();
              setShowForm((prev) => !prev);
            }}
            className="btn-primary-gradient inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{showForm && !editingId ? 'Close Form' : 'Add Scholarship'}</span>
          </button>
        </div>
      </div>

      {/* Create / Edit Form */}
      <AnimatePresence>
        {showForm && (
          <motion.form
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
            onSubmit={handleSave}
            className="surface-elevated rounded-2xl p-6 space-y-5"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3.5">
              <h3 className="text-sm font-semibold text-white font-display">
                {editingId ? `Edit Scholarship (${editingId})` : 'Create New Scholarship Record'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  resetForm();
                  setShowForm(false);
                }}
                className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <X className="w-3.5 h-3.5" />
                <span>Close</span>
              </button>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Title *</label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Official Scheme Title"
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Provider / Ministry *</label>
                <input
                  type="text"
                  required
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  placeholder="Ministry / State Dept / Foundation"
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Category / Type</label>
                <select
                  value={scholarshipType}
                  onChange={(e) => setScholarshipType(e.target.value as ScholarshipType)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                >
                  {ALL_TYPES.map((t) => (
                    <option key={t} value={t} className="bg-[#0B1224] text-slate-100">{t}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Official Application URL *</label>
                <input
                  type="url"
                  required
                  value={officialUrl}
                  onChange={(e) => setOfficialUrl(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Authoritative Source URL</label>
                <input
                  type="url"
                  value={officialSourceUrl}
                  onChange={(e) => setOfficialSourceUrl(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Source Name</label>
                <input
                  type="text"
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  placeholder="e.g. National Scholarship Portal (NSP)"
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Annual Award (INR)</label>
                <input
                  type="number"
                  min="0"
                  value={annualAwardInr}
                  onChange={(e) => setAnnualAwardInr(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Max Income Limit (INR)</label>
                <input
                  type="number"
                  min="0"
                  value={incomeLimitInr}
                  onChange={(e) => setIncomeLimitInr(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Min Marks (%)</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={minMarksPercent}
                  onChange={(e) => setMinMarksPercent(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Start Date (YYYY-MM-DD)</label>
                <input
                  type="text"
                  value={applicationStartDate}
                  onChange={(e) => setApplicationStartDate(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Deadline (YYYY-MM-DD)</label>
                <input
                  type="text"
                  value={applicationDeadline}
                  onChange={(e) => setApplicationDeadline(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Cycle Status</label>
                <select
                  value={applicationStatus}
                  onChange={(e) => setApplicationStatus(e.target.value as ApplicationCycleStatus)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                >
                  {APPLICATION_STATUSES.map((st) => (
                    <option key={st} value={st} className="bg-[#0B1224] text-slate-100">{st}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Education Levels</label>
                <input
                  type="text"
                  value={educationLevelsText}
                  onChange={(e) => setEducationLevelsText(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Eligible States</label>
                <input
                  type="text"
                  value={eligibleStatesText}
                  onChange={(e) => setEligibleStatesText(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Gender Restriction</label>
                <select
                  value={genderRestriction}
                  onChange={(e) => setGenderRestriction(e.target.value as 'All' | 'Female' | 'Male')}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                >
                  <option value="All" className="bg-[#0B1224] text-slate-100">All</option>
                  <option value="Female" className="bg-[#0B1224] text-slate-100">Female Only</option>
                  <option value="Male" className="bg-[#0B1224] text-slate-100">Male Only</option>
                </select>
              </div>
              <div className="sm:col-span-2 lg:col-span-3 space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Allowed Categories</label>
                <input
                  type="text"
                  value={allowedCategoriesText}
                  onChange={(e) => setAllowedCategoriesText(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-3 space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Academic &amp; Stream Notes</label>
                <input
                  type="text"
                  value={academicRequirements}
                  onChange={(e) => setAcademicRequirements(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-3 space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Financial Benefits Summary</label>
                <input
                  type="text"
                  value={financialBenefitsText}
                  onChange={(e) => setFinancialBenefitsText(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-3 space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Description</label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="submit"
                disabled={saving}
                className="btn-primary-gradient px-4 py-2 text-xs font-semibold rounded-xl disabled:opacity-60 whitespace-nowrap shrink-0"
              >
                {saving ? 'Saving to Firestore...' : editingId ? 'Save Changes' : 'Create (Pending Review)'}
              </button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {/* Search, Filters, Sorting */}
      <div className="surface-card rounded-2xl p-4 grid sm:grid-cols-2 lg:grid-cols-6 gap-3">
        <div className="lg:col-span-2 relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search title, provider, ID, state..."
            className="input-midnight w-full pl-9 pr-3 py-2 text-xs rounded-xl"
          />
        </div>
        <select
          aria-label="Filter by category"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="input-midnight px-2.5 py-2 text-xs rounded-xl"
        >
          <option value="ALL" className="bg-[#0B1224] text-slate-100">All Categories</option>
          {ALL_TYPES.map((t) => (
            <option key={t} value={t} className="bg-[#0B1224] text-slate-100">{t}</option>
          ))}
        </select>
        <select
          aria-label="Filter by state"
          value={filterState}
          onChange={(e) => setFilterState(e.target.value)}
          className="input-midnight px-2.5 py-2 text-xs rounded-xl"
        >
          <option value="ALL" className="bg-[#0B1224] text-slate-100">All States</option>
          {INDIAN_STATES_AND_UTS.map((st) => (
            <option key={st} value={st} className="bg-[#0B1224] text-slate-100">{st}</option>
          ))}
        </select>
        <select
          aria-label="Filter by verification status"
          value={filterVerification}
          onChange={(e) => setFilterVerification(e.target.value)}
          className="input-midnight px-2.5 py-2 text-xs rounded-xl"
        >
          <option value="ALL" className="bg-[#0B1224] text-slate-100">All Verification States</option>
          {PHASE9_VERIFICATION_STATUSES.map((vs) => (
            <option key={vs} value={vs} className="bg-[#0B1224] text-slate-100">{vs}</option>
          ))}
        </select>
        <select
          aria-label="Sort scholarships"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="input-midnight px-2.5 py-2 text-xs rounded-xl"
        >
          <option value="updated" className="bg-[#0B1224] text-slate-100">Sort: Recently Updated</option>
          <option value="deadline" className="bg-[#0B1224] text-slate-100">Sort: Nearest Deadline</option>
          <option value="award" className="bg-[#0B1224] text-slate-100">Sort: Highest Award</option>
          <option value="title" className="bg-[#0B1224] text-slate-100">Sort: Title A–Z</option>
        </select>
      </div>

      {/* Tabular Registry */}
      <div className="surface-card rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[#070C1B] border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">Scholarship &amp; Provider</th>
                <th className="py-3.5 px-4">Verification</th>
                <th className="py-3.5 px-4">Cycle &amp; Deadline</th>
                <th className="py-3.5 px-4">Rule Ver.</th>
                <th className="py-3.5 px-4 text-right">Governance Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {pagedRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-slate-400">
                    No scholarships match your current filters.
                  </td>
                </tr>
              ) : (
                pagedRows.map((item) => {
                  const normVer = normalizeVerificationStatus(item.verificationStatus);
                  const effCycle = getEffectiveApplicationStatus(item);
                  return (
                    <tr key={item.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3.5 px-4 max-w-xs">
                        <p className="font-semibold text-white truncate">{item.title}</p>
                        <p className="text-[11px] text-slate-400 truncate mt-0.5">
                          {item.provider} · {item.scholarshipType}
                        </p>
                        <p className="text-[11px] font-mono-num text-slate-500 mt-0.5">{item.id}</p>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className={`inline-block px-2 py-0.5 rounded-md border text-[11px] font-semibold ${statusTextColor(item.verificationStatus)}`}>
                          {normVer}
                        </span>
                        {item.lastVerifiedDate && (
                          <p className="text-[11px] text-slate-400 font-mono-num mt-1">
                            Verified: {item.lastVerifiedDate}
                          </p>
                        )}
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <p className="font-medium text-slate-200">{effCycle}</p>
                        <p className="text-[11px] text-slate-400 font-mono-num mt-0.5">
                          {item.applicationDeadline || 'Check Portal'}
                        </p>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap font-mono-num text-indigo-300 font-semibold">
                        v{item.activeRuleVersion ?? 1}
                      </td>
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onOpenVerification(item.id)}
                            className="px-2.5 py-1.5 text-[11px] font-medium bg-[#101933] border border-slate-700/80 hover:bg-slate-800 text-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                          >
                            Verify
                          </button>
                          <button
                            type="button"
                            onClick={() => onOpenRules(item.id)}
                            className="px-2.5 py-1.5 text-[11px] font-medium bg-indigo-500/15 border border-indigo-500/30 hover:bg-indigo-500/25 text-indigo-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                          >
                            Rules
                          </button>
                          <button
                            type="button"
                            onClick={() => startEdit(item)}
                            aria-label={`Edit ${item.title}`}
                            className="p-1.5 text-slate-300 hover:text-white bg-[#070C1B] border border-slate-800 hover:border-slate-700 rounded-lg transition-colors"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          {normVer !== 'Archived' && (
                            <button
                              type="button"
                              onClick={() => setArchiveTarget(item)}
                              aria-label={`Archive ${item.title}`}
                              className="p-1.5 text-slate-400 hover:text-rose-300 bg-[#070C1B] border border-slate-800 hover:border-rose-500/40 rounded-lg transition-colors"
                            >
                              <Archive className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-4 py-3 border-t border-slate-800 bg-[#070C1B]/50 flex items-center justify-between text-xs text-slate-400">
          <span className="font-mono-num">
            Showing {pagedRows.length} of {filteredScholarships.length} scholarships (Page {currentPage}/{totalPages})
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1.5 bg-[#101933] border border-slate-700/80 text-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-3 py-1.5 bg-[#101933] border border-slate-700/80 text-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Archive Confirmation Modal (No window.confirm) */}
      <AnimatePresence>
        {archiveTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-[#02050D]/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              className="surface-elevated rounded-2xl max-w-md w-full p-6 space-y-4"
            >
              <h3 className="text-base font-semibold text-white font-display">
                Archive Scholarship Record?
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                Archiving <strong className="text-white">{archiveTarget.title}</strong> marks it inactive and prevents new tracked applications, while safely preserving all existing student applications and historical records.
              </p>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Archival Reason</label>
                <input
                  type="text"
                  value={archiveReason}
                  onChange={(e) => setArchiveReason(e.target.value)}
                  placeholder="e.g. Scheme discontinued by issuing authority"
                  className="input-midnight w-full px-3 py-2 text-xs rounded-xl"
                />
              </div>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setArchiveTarget(null)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-xl whitespace-nowrap shrink-0"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={archiving}
                  onClick={() => void handleConfirmArchive()}
                  className="px-3.5 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-xl disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  {archiving ? 'Archiving...' : 'Confirm Archive'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================================================================
// 2. Evidence-Based Verification Queue & Provenance Panel
// ============================================================================

export function AdminVerificationQueuePanel({
  scholarships,
  preselectedScholarshipId,
  getIdToken,
  onReload,
  onNotify,
}: {
  scholarships: Scholarship[];
  preselectedScholarshipId: string | null;
  getIdToken: () => Promise<string>;
  onReload: () => Promise<void>;
  onNotify: (msg: string | null, err?: string | null) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>(preselectedScholarshipId || '');
  const [filterQueueOnly, setFilterQueueOnly] = useState(true);
  const [newStatus, setNewStatus] = useState<VerificationStatus>('Verified');
  const [sourceName, setSourceName] = useState('');
  const [officialSourceUrl, setOfficialSourceUrl] = useState('');
  const [sourceEvidence, setSourceEvidence] = useState('');
  const [verificationNotes, setVerificationNotes] = useState('');
  const [humanConfirmed, setHumanConfirmed] = useState(false);
  const [httpResult, setHttpResult] = useState<{
    reachable: boolean;
    httpStatus: number | null;
    checkedAt: string;
    recommendation: string;
  } | null>(null);
  const [checkingHttp, setCheckingHttp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<ScholarshipVerificationHistoryRecord[]>([]);

  useEffect(() => {
    if (preselectedScholarshipId) {
      setSelectedId(preselectedScholarshipId);
      setFilterQueueOnly(false);
    } else if (!selectedId && scholarships[0]) {
      setSelectedId(scholarships[0].id);
    }
  }, [preselectedScholarshipId, scholarships, selectedId]);

  const queueItems = useMemo(() => {
    return scholarships.filter((s) => {
      if (!filterQueueOnly) return true;
      const norm = normalizeVerificationStatus(s.verificationStatus);
      return norm !== 'Verified' && norm !== 'Archived';
    });
  }, [scholarships, filterQueueOnly]);

  const selectedScholarship = useMemo(
    () => scholarships.find((s) => s.id === selectedId) ?? queueItems[0] ?? null,
    [scholarships, selectedId, queueItems]
  );

  useEffect(() => {
    if (!selectedScholarship) return;
    setSourceName(selectedScholarship.sourceName || selectedScholarship.provider);
    setOfficialSourceUrl(selectedScholarship.officialSourceUrl || selectedScholarship.officialUrl);
    setSourceEvidence(selectedScholarship.sourceEvidence || selectedScholarship.sourceNotes || '');
    setVerificationNotes(selectedScholarship.verificationNotes || '');
    setHumanConfirmed(false);
    setHttpResult(null);

    (async () => {
      try {
        const token = await getIdToken();
        const res = await getProtectedApi<{ history: ScholarshipVerificationHistoryRecord[] }>(
          `/api/admin/scholarships/${selectedScholarship.id}/verification-history`,
          token
        );
        setHistory(res.history);
      } catch {
        setHistory([]);
      }
    })();
  }, [selectedScholarship?.id, getIdToken]);

  const handleHttpCheck = async () => {
    if (!officialSourceUrl.trim()) return;
    setCheckingHttp(true);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{
        reachable: boolean;
        httpStatus: number | null;
        checkedAt: string;
        recommendation: string;
      }>('/api/admin/verify-source', token, { url: officialSourceUrl.trim() });
      setHttpResult(res);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'HTTP source check failed.');
    } finally {
      setCheckingHttp(false);
    }
  };

  const handleApplyVerification = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedScholarship) return;
    setSubmitting(true);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      await postProtectedAi(`/api/admin/scholarships/${selectedScholarship.id}/verify`, token, {
        newStatus,
        sourceName: sourceName.trim(),
        officialSourceUrl: officialSourceUrl.trim(),
        sourceEvidence: sourceEvidence.trim(),
        verificationNotes: verificationNotes.trim(),
        humanConfirmed,
        httpCheckStatus: httpResult?.httpStatus ?? null,
      });
      await onReload();
      const histRes = await getProtectedApi<{ history: ScholarshipVerificationHistoryRecord[] }>(
        `/api/admin/scholarships/${selectedScholarship.id}/verification-history`,
        token
      );
      setHistory(histRes.history);
      setHumanConfirmed(false);
      onNotify(
        `Verification status for "${selectedScholarship.title}" updated to ${newStatus} and logged in verification history.`,
        null
      );
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Verification update failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid lg:grid-cols-12 gap-6">
      <div className="lg:col-span-5 surface-card rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-white font-display">
            Verification Queue (<span className="font-mono-num">{queueItems.length}</span>)
          </h2>
          <button
            type="button"
            onClick={() => setFilterQueueOnly((v) => !v)}
            className="text-xs font-medium text-indigo-300 hover:text-indigo-200 hover:underline whitespace-nowrap shrink-0"
          >
            {filterQueueOnly ? 'Show All Schemes' : 'Show Queue Only'}
          </button>
        </div>

        <div className="divide-y divide-slate-800/70 max-h-[540px] overflow-y-auto pr-1">
          {queueItems.length === 0 ? (
            <p className="text-xs text-slate-400 py-8 text-center">
              All non-archived scholarships are currently verified. Toggle &ldquo;Show All Schemes&rdquo; to audit provenance.
            </p>
          ) : (
            queueItems.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedId(s.id)}
                className={`w-full text-left py-3 px-3 rounded-xl transition-colors ${
                  selectedScholarship?.id === s.id
                    ? 'bg-indigo-500/15 border border-indigo-500/30'
                    : 'hover:bg-slate-800/40 border border-transparent'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-white truncate">{s.title}</p>
                  <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-semibold shrink-0 ${statusTextColor(s.verificationStatus)}`}>
                    {normalizeVerificationStatus(s.verificationStatus)}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 truncate mt-1">{s.provider}</p>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="lg:col-span-7 space-y-6">
        {selectedScholarship ? (
          <>
            <form
              onSubmit={handleApplyVerification}
              className="surface-card rounded-2xl p-6 space-y-4"
            >
              <div className="border-b border-slate-800 pb-3.5 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-white font-display">
                    {selectedScholarship.title}
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Current Status:{' '}
                    <span className="font-semibold text-slate-200">
                      {normalizeVerificationStatus(selectedScholarship.verificationStatus)}
                    </span>
                    {selectedScholarship.verifiedByEmail && (
                      <> · Last Verified By: {selectedScholarship.verifiedByEmail}</>
                    )}
                  </p>
                </div>
                <a
                  href={selectedScholarship.officialUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-300 hover:text-indigo-200 hover:underline shrink-0 whitespace-nowrap"
                >
                  <span>Open Portal</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>

              <div className="p-3.5 rounded-xl bg-[#070C1B]/80 border border-slate-800 text-xs text-slate-300 leading-relaxed">
                <strong className="text-white">Strict Governance Rule:</strong> Reachable URLs or AI summaries never auto-verify a scholarship. Marking <strong className="text-emerald-300">Verified</strong> requires a valid official source URL, recorded evidence, and explicit human administrator confirmation.
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">Authoritative Source Name</label>
                  <input
                    type="text"
                    value={sourceName}
                    onChange={(e) => setSourceName(e.target.value)}
                    className="input-midnight w-full px-3 py-2 text-xs rounded-xl"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">Target Verification Status</label>
                  <select
                    value={newStatus}
                    onChange={(e) => setNewStatus(e.target.value as VerificationStatus)}
                    className="input-midnight w-full px-3 py-2 text-xs rounded-xl"
                  >
                    {PHASE9_VERIFICATION_STATUSES.map((st) => (
                      <option key={st} value={st} className="bg-[#0B1224] text-slate-100">{st}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Official Source URL</label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="url"
                    required
                    value={officialSourceUrl}
                    onChange={(e) => setOfficialSourceUrl(e.target.value)}
                    className="input-midnight flex-1 px-3 py-2 text-xs rounded-xl"
                  />
                  <button
                    type="button"
                    disabled={checkingHttp}
                    onClick={() => void handleHttpCheck()}
                    className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-[#101933] border border-slate-700/80 hover:bg-slate-800 text-slate-200 rounded-xl shrink-0 whitespace-nowrap transition-colors"
                  >
                    <Globe className="w-3.5 h-3.5 text-indigo-400" />
                    <span>{checkingHttp ? 'Checking...' : 'Test HTTP Reachability'}</span>
                  </button>
                </div>
                {httpResult && (
                  <p className={`text-xs mt-1.5 font-medium font-mono-num ${httpResult.reachable ? 'text-emerald-300' : 'text-rose-300'}`}>
                    HTTP Status: {httpResult.httpStatus ?? 'Unreachable'} — {httpResult.recommendation}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  Authoritative Source Evidence / Notification Citation *
                </label>
                <textarea
                  rows={2}
                  value={sourceEvidence}
                  onChange={(e) => setSourceEvidence(e.target.value)}
                  placeholder="Cite official portal guideline PDF, gazette notice, income ceiling, and deadline source..."
                  className="input-midnight w-full px-3 py-2 text-xs rounded-xl"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Verification Review Notes</label>
                <input
                  type="text"
                  value={verificationNotes}
                  onChange={(e) => setVerificationNotes(e.target.value)}
                  placeholder="Internal review comments or correction details"
                  className="input-midnight w-full px-3 py-2 text-xs rounded-xl"
                />
              </div>

              {newStatus === 'Verified' && (
                <label className="flex items-start gap-2.5 p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={humanConfirmed}
                    onChange={(e) => setHumanConfirmed(e.target.checked)}
                    className="mt-0.5 rounded border-emerald-500/50 bg-[#070C1B] text-emerald-500"
                  />
                  <span>
                    I confirm that I have personally reviewed the official source URL and authoritative circular/portal evidence, and approve marking this scholarship <strong className="text-white">Verified</strong>.
                  </span>
                </label>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={submitting}
                  className="btn-primary-gradient inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>{submitting ? 'Recording Verification...' : 'Commit Verification Decision'}</span>
                </button>
              </div>
            </form>

            {/* Immutable Verification History */}
            <div className="surface-card rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-white font-display flex items-center gap-2">
                <History className="w-4 h-4 text-indigo-400" />
                <span>Verification History (<span className="font-mono-num">{history.length}</span>)</span>
              </h3>
              {history.length === 0 ? (
                <p className="text-xs text-slate-400">No verification transitions recorded for this scheme yet.</p>
              ) : (
                <div className="divide-y divide-slate-800/70">
                  {history.map((h) => (
                    <div key={h.id} className="py-3 text-xs space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-white">
                          {h.previousStatus} → {h.newStatus}
                        </span>
                        <span className="text-[11px] font-mono-num text-slate-400">
                          {new Date(h.createdAt).toLocaleString('en-IN')}
                        </span>
                      </div>
                      <p className="text-slate-300">{h.sourceEvidence}</p>
                      <p className="text-[11px] text-slate-400">
                        Admin: {h.adminEmail} · Source: {h.officialSourceUrl}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="surface-card rounded-2xl p-8 text-center text-xs text-slate-400">
            Select a scholarship on the left to review provenance and apply verification decisions.
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 3. Eligibility Rules & Versioning Panel
// ============================================================================

export function AdminEligibilityRulesPanel({
  scholarships,
  preselectedScholarshipId,
  getIdToken,
  onReload,
  onNotify,
}: {
  scholarships: Scholarship[];
  preselectedScholarshipId: string | null;
  getIdToken: () => Promise<string>;
  onReload: () => Promise<void>;
  onNotify: (msg: string | null, err?: string | null) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>(preselectedScholarshipId || '');
  const [rules, setRules] = useState<RuleDraftInput[]>([]);
  const [versions, setVersions] = useState<ScholarshipRuleVersionRecord[]>([]);
  const [changeSummary, setChangeSummary] = useState('');
  const [loadingRules, setLoadingRules] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (preselectedScholarshipId) {
      setSelectedId(preselectedScholarshipId);
    } else if (!selectedId && scholarships[0]) {
      setSelectedId(scholarships[0].id);
    }
  }, [preselectedScholarshipId, scholarships, selectedId]);

  const selectedScholarship = useMemo(
    () => scholarships.find((s) => s.id === selectedId) ?? null,
    [scholarships, selectedId]
  );

  useEffect(() => {
    if (!selectedScholarship) return;
    setLoadingRules(true);
    (async () => {
      try {
        const token = await getIdToken();
        const res = await getProtectedApi<{
          rules: ScholarshipEligibilityRule[];
          versions: ScholarshipRuleVersionRecord[];
        }>(`/api/admin/scholarships/${selectedScholarship.id}/rules`, token);
        setRules(
          res.rules.map((r) => ({
            id: r.id,
            ruleKey: r.ruleKey,
            ruleLabel: r.ruleLabel,
            operator: r.operator,
            ruleValue: r.ruleValue,
            isMandatory: r.isMandatory,
            isActive: r.isActive !== false,
            description: r.description || '',
          }))
        );
        setVersions(res.versions);
      } catch (err) {
        onNotify(null, err instanceof Error ? err.message : 'Failed to load eligibility rules.');
      } finally {
        setLoadingRules(false);
      }
    })();
  }, [selectedScholarship?.id, getIdToken]);

  const liveContradictions = useMemo(() => detectRuleContradictions(rules), [rules]);

  const handleAddRule = () => {
    setRules((prev) => [
      ...prev,
      {
        ruleKey: 'familyAnnualIncomeInr',
        ruleLabel: 'Maximum Family Income Ceiling',
        operator: 'lte',
        ruleValue: '250000',
        isMandatory: true,
        isActive: true,
        description: '',
      },
    ]);
  };

  const handleSaveRules = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedScholarship) return;
    if (liveContradictions.length > 0) {
      onNotify(null, liveContradictions.join(' '));
      return;
    }
    setSaving(true);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{
        versionRecord: ScholarshipRuleVersionRecord;
      }>(`/api/admin/scholarships/${selectedScholarship.id}/rules`, token, {
        changeSummary: changeSummary.trim() || `Updated structured eligibility rules`,
        rules,
      });
      setChangeSummary('');
      await onReload();
      const refreshed = await getProtectedApi<{
        rules: ScholarshipEligibilityRule[];
        versions: ScholarshipRuleVersionRecord[];
      }>(`/api/admin/scholarships/${selectedScholarship.id}/rules`, token);
      setVersions(refreshed.versions);
      onNotify(
        `Saved eligibility rules as version v${res.versionRecord.versionNumber}. Active eligibility engine will immediately apply v${res.versionRecord.versionNumber} while preserving historical assessments.`,
        null
      );
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to save eligibility rules.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="surface-card rounded-2xl p-5 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="flex-1 space-y-1.5">
          <label htmlFor="rules-sch-select" className="text-xs font-medium text-slate-300">
            Select Scholarship for Rule Governance
          </label>
          <select
            id="rules-sch-select"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="input-midnight w-full px-3 py-2 text-sm rounded-xl"
          >
            {scholarships.map((s) => (
              <option key={s.id} value={s.id} className="bg-[#0B1224] text-slate-100">
                {s.title} (Active v{s.activeRuleVersion ?? 1})
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={handleAddRule}
          disabled={!selectedScholarship}
          className="btn-primary-gradient inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold rounded-xl shrink-0 whitespace-nowrap disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Structured Rule</span>
        </button>
      </div>

      {selectedScholarship && (
        <div className="grid lg:grid-cols-12 gap-6">
          <form onSubmit={handleSaveRules} className="lg:col-span-8 surface-card rounded-2xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3.5">
              <div>
                <h3 className="text-sm font-semibold text-white font-display flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4 text-indigo-400" />
                  <span>Structured Eligibility Rules (<span className="font-mono-num">{rules.length}</span>)</span>
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Deterministic checks validate formats &amp; contradictions before saving.
                </p>
              </div>
              <span className="text-xs font-mono-num text-indigo-300 font-semibold">
                Active Rule Version: v{selectedScholarship.activeRuleVersion ?? 1}
              </span>
            </div>

            {loadingRules ? (
              <div className="space-y-3 py-2">
                <SkeletonCard className="h-24" />
                <SkeletonCard className="h-24" />
              </div>
            ) : rules.length === 0 ? (
              <p className="text-xs text-slate-400 py-6">
                No custom structured rules configured yet. Base scholarship attributes still apply, and clicking &ldquo;Add Structured Rule&rdquo; lets you layer strict versioned criteria.
              </p>
            ) : (
              <div className="space-y-3">
                {rules.map((r, idx) => (
                  <div key={r.id ?? idx} className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800 space-y-3">
                    <div className="grid sm:grid-cols-4 gap-3">
                      <select
                        value={r.ruleKey}
                        onChange={(e) =>
                          setRules((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, ruleKey: e.target.value } : item))
                          )
                        }
                        className="input-midnight px-2.5 py-2 text-xs rounded-lg"
                      >
                        {ALLOWED_RULE_KEYS.map((k) => (
                          <option key={k} value={k} className="bg-[#0B1224] text-slate-100">{k}</option>
                        ))}
                      </select>
                      <select
                        value={r.operator}
                        onChange={(e) =>
                          setRules((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, operator: e.target.value as EligibilityRuleOperator } : item
                            )
                          )
                        }
                        className="input-midnight px-2.5 py-2 text-xs rounded-lg"
                      >
                        <option value="lte" className="bg-[#0B1224] text-slate-100">lte (&lt;=)</option>
                        <option value="gte" className="bg-[#0B1224] text-slate-100">gte (&gt;=)</option>
                        <option value="eq" className="bg-[#0B1224] text-slate-100">eq (=)</option>
                        <option value="neq" className="bg-[#0B1224] text-slate-100">neq (!=)</option>
                        <option value="in" className="bg-[#0B1224] text-slate-100">in (comma list)</option>
                        <option value="contains" className="bg-[#0B1224] text-slate-100">contains</option>
                      </select>
                      <input
                        type="text"
                        required
                        value={r.ruleValue}
                        onChange={(e) =>
                          setRules((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, ruleValue: e.target.value } : item))
                          )
                        }
                        placeholder="Threshold or comma list"
                        className="input-midnight sm:col-span-2 px-2.5 py-2 text-xs rounded-lg font-mono-num"
                      />
                    </div>
                    <div className="grid sm:grid-cols-3 gap-3 items-center">
                      <input
                        type="text"
                        required
                        value={r.ruleLabel}
                        onChange={(e) =>
                          setRules((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, ruleLabel: e.target.value } : item))
                          )
                        }
                        placeholder="Criterion Display Label"
                        className="input-midnight sm:col-span-2 px-2.5 py-2 text-xs rounded-lg"
                      />
                      <div className="flex items-center justify-between gap-2 text-xs text-slate-300">
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={r.isMandatory}
                            onChange={(e) =>
                              setRules((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, isMandatory: e.target.checked } : item))
                              )
                            }
                            className="rounded border-slate-700 bg-[#070C1B] text-indigo-500"
                          />
                          <span>Mandatory</span>
                        </label>
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={r.isActive !== false}
                            onChange={(e) =>
                              setRules((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, isActive: e.target.checked } : item))
                              )
                            }
                            className="rounded border-slate-700 bg-[#070C1B] text-indigo-500"
                          />
                          <span>Active</span>
                        </label>
                        <button
                          type="button"
                          onClick={() => setRules((prev) => prev.filter((_, i) => i !== idx))}
                          className="text-rose-300 hover:text-rose-200 hover:underline font-medium whitespace-nowrap shrink-0"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {liveContradictions.length > 0 && (
              <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200 space-y-1">
                <p className="font-semibold flex items-center gap-1.5 text-rose-300">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>Rule Validation / Contradiction Detected</span>
                </p>
                {liveContradictions.map((err, i) => (
                  <p key={i}>• {err}</p>
                ))}
              </div>
            )}

            <div className="space-y-1.5 pt-2">
              <label className="text-xs font-medium text-slate-300">
                Version Change Summary *
              </label>
              <input
                type="text"
                required
                value={changeSummary}
                onChange={(e) => setChangeSummary(e.target.value)}
                placeholder="e.g. Updated AY 2025-26 family income cap per Ministry circular"
                className="input-midnight w-full px-3 py-2 text-xs rounded-xl"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving || liveContradictions.length > 0}
                className="btn-primary-gradient px-4 py-2 text-xs font-semibold rounded-xl disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {saving ? 'Publishing New Rule Version...' : 'Save & Publish New Version'}
              </button>
            </div>
          </form>

          {/* Rule Version Snapshots */}
          <div className="lg:col-span-4 surface-card rounded-2xl p-5 space-y-3">
            <h3 className="text-sm font-semibold text-white font-display flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-400" />
              <span>Version History (<span className="font-mono-num">{versions.length}</span>)</span>
            </h3>
            <p className="text-xs text-slate-400">
              Historical student eligibility assessments preserve their recorded <code className="font-mono text-indigo-300">ruleVersionUsed</code>.
            </p>
            {versions.length === 0 ? (
              <p className="text-xs text-slate-400 pt-2">No rule version snapshots published yet.</p>
            ) : (
              <div className="divide-y divide-slate-800/70 max-h-[460px] overflow-y-auto pr-1">
                {versions.map((v) => (
                  <div key={v.id} className="py-3 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold font-mono-num text-white">Version v{v.versionNumber}</span>
                      <span className="text-[11px] font-mono-num text-slate-400">
                        {new Date(v.createdAt).toLocaleDateString('en-IN')}
                      </span>
                    </div>
                    <p className="text-slate-300">{v.changeSummary}</p>
                    <p className="text-[11px] text-slate-400">
                      {v.rulesSnapshot.length} rule(s) · By {v.changedByEmail}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 4. Data Quality & Duplicate Detection Panel
// ============================================================================

export function AdminDataQualityPanel({
  getIdToken,
  onNotify,
  onOpenScholarshipVerify,
}: {
  getIdToken: () => Promise<string>;
  onNotify: (msg: string | null, err?: string | null) => void;
  onOpenScholarshipVerify: (scholarshipId: string) => void;
}) {
  const [issues, setIssues] = useState<DataQualityIssueRecord[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>('Open');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const loadQuality = async () => {
    setLoading(true);
    try {
      const token = await getIdToken();
      const res = await getProtectedApi<{
        persistedIssues: DataQualityIssueRecord[];
        liveIssues: DataQualityIssueRecord[];
      }>('/api/admin/data-quality', token);
      setIssues(res.persistedIssues.length > 0 ? res.persistedIssues : res.liveIssues);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to load data quality queue.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadQuality();
  }, []);

  const handleRunScan = async () => {
    setScanning(true);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{
        issues: DataQualityIssueRecord[];
        activeCount: number;
        resolvedCount: number;
      }>('/api/admin/data-quality/scan', token, {});
      setIssues(res.issues);
      onNotify(
        `Catalog quality scan completed: ${res.activeCount} active issue(s) persisted, ${res.resolvedCount} cleared.`,
        null
      );
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Data quality scan failed.');
    } finally {
      setScanning(false);
    }
  };

  const handleUpdateIssue = async (
    issue: DataQualityIssueRecord,
    resolutionStatus: DataQualityResolutionStatus
  ) => {
    onNotify(null, null);
    try {
      const token = await getIdToken();
      await patchProtectedApi(`/api/admin/data-quality/issues/${issue.id}`, token, {
        resolutionStatus,
        resolutionNote: `Marked ${resolutionStatus} by administrator`,
      });
      await loadQuality();
      onNotify(`Issue "${issue.issueType}" on "${issue.scholarshipTitle}" updated to ${resolutionStatus}.`, null);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to update issue status.');
    }
  };

  const visibleIssues = useMemo(() => {
    return issues.filter((i) => filterStatus === 'ALL' || i.resolutionStatus === filterStatus);
  }, [issues, filterStatus]);

  return (
    <div className="space-y-6">
      <div className="surface-card rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
            <FileCheck2 className="w-4 h-4 text-amber-400" />
            <span>Data Quality &amp; Duplicate Detection (<span className="font-mono-num">{issues.length}</span>)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Flags duplicate candidates, missing official URLs, missing/invalid deadlines, conflicting bounds, and outdated verification without ever auto-deleting records.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="input-midnight px-3 py-2 text-xs rounded-xl"
          >
            <option value="Open" className="bg-[#0B1224] text-slate-100">Open Issues</option>
            <option value="Acknowledged" className="bg-[#0B1224] text-slate-100">Acknowledged</option>
            <option value="Resolved" className="bg-[#0B1224] text-slate-100">Resolved</option>
            <option value="Ignored" className="bg-[#0B1224] text-slate-100">Ignored</option>
            <option value="ALL" className="bg-[#0B1224] text-slate-100">All Issues</option>
          </select>
          <button
            type="button"
            onClick={() => void handleRunScan()}
            disabled={scanning}
            className="btn-primary-gradient inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
            <span>{scanning ? 'Scanning Catalog...' : 'Run Quality & Duplicate Scan'}</span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          <SkeletonCard className="h-24" />
          <SkeletonCard className="h-24" />
        </div>
      ) : visibleIssues.length === 0 ? (
        <div className="surface-card rounded-2xl p-8 text-center text-xs text-slate-400">
          <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto mb-2" />
          No {filterStatus === 'ALL' ? '' : filterStatus.toLowerCase()} data quality issues found. Click &ldquo;Run Quality &amp; Duplicate Scan&rdquo; to verify live records.
        </div>
      ) : (
        <div className="space-y-3">
          {visibleIssues.map((issue) => (
            <div
              key={issue.id}
              className="surface-card rounded-2xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 text-xs"
            >
              <div className="space-y-1.5 min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-md border text-[11px] font-semibold ${severityBadgeClass(issue.severity)}`}>
                    {issue.severity}
                  </span>
                  <span className="font-semibold text-white">{issue.issueType}</span>
                  <span className="text-slate-500">·</span>
                  <span className="font-medium text-slate-300">{issue.scholarshipTitle}</span>
                  {issue.relatedScholarshipTitle && (
                    <span className="text-amber-300 font-medium">
                      ↔ {issue.relatedScholarshipTitle}
                    </span>
                  )}
                </div>
                <p className="text-slate-300 leading-relaxed">{issue.description}</p>
                <p className="text-[11px] text-slate-400">
                  <strong className="text-slate-300">Recommended Correction:</strong> {issue.recommendedCorrection}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => onOpenScholarshipVerify(issue.scholarshipId)}
                  className="px-3 py-1.5 text-[11px] font-medium bg-indigo-500/15 border border-indigo-500/30 hover:bg-indigo-500/25 text-indigo-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  Inspect Record
                </button>
                {issue.resolutionStatus !== 'Acknowledged' && (
                  <button
                    type="button"
                    onClick={() => void handleUpdateIssue(issue, 'Acknowledged')}
                    className="px-3 py-1.5 text-[11px] font-medium bg-[#101933] border border-slate-700/80 text-slate-200 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    Acknowledge
                  </button>
                )}
                {issue.resolutionStatus !== 'Resolved' && (
                  <button
                    type="button"
                    onClick={() => void handleUpdateIssue(issue, 'Resolved')}
                    className="px-3 py-1.5 text-[11px] font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 transition-colors whitespace-nowrap shrink-0"
                  >
                    Mark Resolved
                  </button>
                )}
                {issue.resolutionStatus !== 'Ignored' && (
                  <button
                    type="button"
                    onClick={() => void handleUpdateIssue(issue, 'Ignored')}
                    className="px-3 py-1.5 text-[11px] font-medium text-slate-300 bg-[#070C1B] border border-slate-800 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    Ignore
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
