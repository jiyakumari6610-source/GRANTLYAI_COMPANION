import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  FileText,
  History,
  Info,
  MessageSquareText,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import {
  AnimatedCounter,
  CircularProgressRing,
  PageTransition,
  SkeletonCard,
} from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { fetchProtectedBlob, postProtectedAi } from '../lib/apiClient.ts';
import {
  createTrustGuardReport,
  getApplications,
  getDocumentAnalyses,
  getDocuments,
  getSavedScholarships,
  getScholarships,
  getTrustGuardAssessments,
  getTrustGuardReports,
  makeId,
  saveTrustGuardAssessment,
  updateTrustGuardAssessmentFindings,
} from '../lib/firestoreRepo.ts';
import {
  evaluateTrustGuardVerification,
  TRUSTGUARD_DISCLAIMER,
  TRUSTGUARD_LIMITATION_NOTICE,
} from '../lib/trustguardEngine.ts';
import type {
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  SavedScholarship,
  Scholarship,
  TrustGuardDocumentAssessment,
  TrustGuardFinding,
  TrustGuardReport,
  TrustGuardReviewStatus,
  TrustGuardRiskSeverity,
  TrustGuardVerificationStatus,
} from '../types/database.ts';

type WorkspaceTab = 'documents' | 'scam';
type SeverityFilter = 'All' | TrustGuardRiskSeverity;
type ChangeFilter = 'All' | 'New' | 'Unchanged';

const TRUSTGUARD_COMPANION_PROMPTS = [
  'Why did TrustGuard flag my documents?',
  'Which inconsistencies could affect my scholarship eligibility?',
  'Explain the difference between a mismatch and manual review in my TrustGuard report.',
  'What corrective steps should I finish first before applying?',
] as const;

interface TrustGuardAnalyzeResponse {
  assessment: Omit<TrustGuardDocumentAssessment, 'id' | 'createdAt' | 'updatedAt'>;
  aiSummary?: string;
  aiReusedFromCache?: boolean;
  sourceMode?: string;
}

function getVerificationStatusClass(status: TrustGuardVerificationStatus): string {
  switch (status) {
    case 'Verified Against Available Records':
    case 'Consistency Check Completed':
      return 'text-emerald-300';
    case 'Manual Review Required':
    case 'Analysis In Progress':
      return 'text-amber-300';
    case 'Information Mismatch Detected':
    case 'Unable to Verify':
      return 'text-rose-300';
    case 'Not Analyzed':
    default:
      return 'text-slate-400';
  }
}

function getSeverityTextClass(severity: TrustGuardRiskSeverity): string {
  switch (severity) {
    case 'Critical':
    case 'High':
      return 'text-rose-300';
    case 'Medium':
      return 'text-amber-300';
    case 'Low':
      return 'text-indigo-300';
    case 'Informational':
    default:
      return 'text-slate-400';
  }
}

export default function TrustGuardPage() {
  const { user, isAdmin, profile, getIdToken } = useAuth();
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('documents');

  // Shared student records for Document Verification Intelligence
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [documentAnalyses, setDocumentAnalyses] = useState<DocumentAnalysis[]>([]);
  const [scholarships, setScholarships] = useState<Scholarship[]>([]);
  const [savedScholarships, setSavedScholarships] = useState<SavedScholarship[]>([]);
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [assessments, setAssessments] = useState<TrustGuardDocumentAssessment[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string>('latest');

  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [savingFindingId, setSavingFindingId] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  // Filters & drawers
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('All');
  const [changeFilter, setChangeFilter] = useState<ChangeFilter>('All');
  const [showResolvedDrawer, setShowResolvedDrawer] = useState(false);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  // Private vault file preview modal
  const [previewDoc, setPreviewDoc] = useState<{
    fileName: string;
    mimeType: string;
    objectUrl: string;
  } | null>(null);
  const [previewBusyId, setPreviewBusyId] = useState<string | null>(null);

  // Existing URL & Message Scam Screening state
  const [reports, setReports] = useState<TrustGuardReport[]>([]);
  const [submittedUrlOrText, setSubmittedUrlOrText] = useState('');
  const [claimsFeeOrDeposit, setClaimsFeeOrDeposit] = useState(false);
  const [scamBusy, setScamBusy] = useState(false);
  const [scamError, setScamError] = useState<string | null>(null);

  const previewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, []);

  const loadWorkspace = useCallback(async () => {
    if (!user) return;
    setLoadingWorkspace(true);
    setDocError(null);
    try {
      const [docs, analyses, schRes, saved, apps, pastAssessments, pastReports] =
        await Promise.all([
          getDocuments(user.uid),
          getDocumentAnalyses(user.uid),
          getScholarships(),
          getSavedScholarships(user.uid),
          getApplications(user.uid),
          getTrustGuardAssessments(user.uid),
          getTrustGuardReports(user.uid, isAdmin),
        ]);
      setDocuments(docs);
      setDocumentAnalyses(analyses);
      setScholarships(schRes.items);
      setSavedScholarships(saved);
      setApplications(apps);
      setAssessments(pastAssessments);
      setReports(pastReports);
    } catch (err) {
      setDocError(err instanceof Error ? err.message : 'Unable to load TrustGuard records.');
    } finally {
      setLoadingWorkspace(false);
    }
  }, [user, isAdmin]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  // Deterministic live computation from current Firestore state
  const liveEvaluation = useMemo(() => {
    if (!user) return null;
    return evaluateTrustGuardVerification({
      userId: user.uid,
      profile,
      documents,
      documentAnalyses,
      scholarships,
      savedScholarships,
      applications,
      previousAssessment: assessments[0] ?? null,
    });
  }, [user, profile, documents, documentAnalyses, scholarships, savedScholarships, applications, assessments]);

  const latestSaved = assessments[0] ?? null;

  const displayedAssessment: TrustGuardDocumentAssessment | null = useMemo(() => {
    if (selectedSnapshotId !== 'latest') {
      return assessments.find((a) => a.id === selectedSnapshotId) ?? latestSaved;
    }
    if (latestSaved) return latestSaved;
    if (!liveEvaluation) return null;
    const now = new Date().toISOString();
    return {
      id: 'live-preview',
      createdAt: now,
      updatedAt: now,
      ...liveEvaluation,
    };
  }, [selectedSnapshotId, assessments, latestSaved, liveEvaluation]);

  const isViewingHistorical =
    selectedSnapshotId !== 'latest' && latestSaved && selectedSnapshotId !== latestSaved.id;

  const isSnapshotStale = Boolean(
    latestSaved && liveEvaluation && latestSaved.dataFingerprint !== liveEvaluation.dataFingerprint
  );

  useEffect(() => {
    if (!displayedAssessment) return;
    const drafts: Record<string, string> = {};
    for (const f of displayedAssessment.findings) {
      drafts[f.findingId] = f.studentNote ?? '';
    }
    setNoteDrafts(drafts);
  }, [displayedAssessment]);

  const handleRunAudit = async (includeAiSummary: boolean) => {
    if (!user) return;
    setAnalyzing(true);
    setDocError(null);
    setStatusNotice(null);

    try {
      const token = await getIdToken();
      const res = await postProtectedAi<TrustGuardAnalyzeResponse>(
        '/api/trustguard/analyze',
        token,
        {
          includeAiSummary,
          cachedAssessment: latestSaved
            ? {
                dataFingerprint: latestSaved.dataFingerprint,
                aiSummary: latestSaved.aiSummary,
              }
            : null,
          studentContext: {
            profile,
            documents,
            documentAnalyses,
            savedScholarships,
            applications,
            trustGuardAssessments: assessments.slice(0, 3),
          },
        }
      );

      const now = new Date().toISOString();
      const newRecord: TrustGuardDocumentAssessment = {
        id: makeId('tga'),
        ...res.assessment,
        ...(res.aiSummary ? { aiSummary: res.aiSummary } : {}),
        createdAt: now,
        updatedAt: now,
      };

      await saveTrustGuardAssessment(newRecord);
      setAssessments((prev) => [newRecord, ...prev]);
      setSelectedSnapshotId('latest');
      setStatusNotice(
        includeAiSummary
          ? res.aiReusedFromCache
            ? 'Verification audit saved (reused cached Gemini briefing because underlying documents and profile are unchanged).'
            : 'TrustGuard verification audit and Gemini risk briefing saved to your account.'
          : 'Deterministic TrustGuard verification audit saved to your account.'
      );
    } catch (err) {
      setDocError(err instanceof Error ? err.message : 'Unable to run TrustGuard verification.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleUpdateFindingReview = async (
    findingId: string,
    reviewStatus: TrustGuardReviewStatus
  ) => {
    if (!user || !latestSaved || isViewingHistorical) return;
    setSavingFindingId(findingId);
    setDocError(null);

    try {
      const now = new Date().toISOString();
      const noteValue = (noteDrafts[findingId] ?? '').trim().slice(0, 400);
      const updatedFindings: TrustGuardFinding[] = latestSaved.findings.map((f) =>
        f.findingId === findingId
          ? {
              ...f,
              reviewStatus,
              ...(noteValue ? { studentNote: noteValue } : {}),
              reviewedAt: now,
            }
          : f
      );

      await updateTrustGuardAssessmentFindings(latestSaved.id, updatedFindings, now);
      setAssessments((prev) =>
        prev.map((a) =>
          a.id === latestSaved.id
            ? { ...a, findings: updatedFindings, updatedAt: now }
            : a
        )
      );
      setStatusNotice(`Saved review status "${reviewStatus}" without modifying extracted evidence.`);
    } catch (err) {
      setDocError(err instanceof Error ? err.message : 'Failed to save finding review note.');
    } finally {
      setSavingFindingId(null);
    }
  };

  const handlePreviewPrivateDoc = async (docId: string, fileName: string, mimeType?: string) => {
    if (!user) return;
    setPreviewBusyId(docId);
    setDocError(null);
    try {
      const token = await getIdToken();
      const blob = await fetchProtectedBlob(`/api/documents/${encodeURIComponent(docId)}/content`, token);
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      const objectUrl = URL.createObjectURL(blob);
      previewUrlRef.current = objectUrl;
      setPreviewDoc({
        fileName,
        mimeType: mimeType || blob.type || 'application/pdf',
        objectUrl,
      });
    } catch (err) {
      setDocError(
        err instanceof Error
          ? err.message
          : 'Unable to load private vault preview. Re-upload the file in Document Intelligence if missing.'
      );
    } finally {
      setPreviewBusyId(null);
    }
  };

  const closePreview = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewDoc(null);
  };

  const filteredFindings = useMemo(() => {
    if (!displayedAssessment) return [];
    return displayedAssessment.findings.filter((f) => {
      if (severityFilter !== 'All' && f.severity !== severityFilter) return false;
      if (changeFilter !== 'All' && f.changeState !== changeFilter) return false;
      return true;
    });
  }, [displayedAssessment, severityFilter, changeFilter]);

  const handleInspectAndReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || submittedUrlOrText.trim().length < 3) return;

    setScamError(null);
    setScamBusy(true);
    try {
      const token = await getIdToken();
      const aiRes = await postProtectedAi<{
        riskLevel: 'Low Risk' | 'Caution' | 'High Risk';
        summary: string;
      }>('/api/ai/trustguard', token, {
        submittedUrlOrText: submittedUrlOrText.trim(),
        claimsFeeOrDeposit,
      });

      const now = new Date().toISOString();
      const report: TrustGuardReport = {
        id: makeId('tg'),
        userId: user.uid,
        reportCategory: 'scam_check',
        submittedUrlOrText: submittedUrlOrText.trim(),
        claimsFeeOrDeposit,
        riskLevel: aiRes.riskLevel,
        analysisSummary: aiRes.summary,
        status: aiRes.riskLevel === 'High Risk' ? 'Under Review' : 'Open',
        createdAt: now,
        updatedAt: now,
      };
      await createTrustGuardReport(report);
      setReports((prev) => [report, ...prev]);
      setSubmittedUrlOrText('');
      setClaimsFeeOrDeposit(false);
    } catch (err) {
      setScamError(err instanceof Error ? err.message : 'TrustGuard inspection failed.');
    } finally {
      setScamBusy(false);
    }
  };

  const verifiedRecordCount = displayedAssessment
    ? displayedAssessment.documentResults.filter(
        (d) => d.verificationStatus === 'Verified Against Available Records'
      ).length
    : 0;
  const totalDocsForRing = displayedAssessment?.documentsTotalCount ?? 0;
  const verifiedPercent =
    totalDocsForRing > 0 ? Math.round((verifiedRecordCount / totalDocsForRing) * 100) : 0;

  return (
    <AppShell
      title="TrustGuard"
      breadcrumb="Workspace / Document Verification & Risk Intelligence"
      primaryAction={
        <div className="flex items-center gap-1 p-1 bg-[#070C1B] border border-slate-800 rounded-xl">
          <button
            type="button"
            onClick={() => setActiveTab('documents')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 transition-colors ${
              activeTab === 'documents'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Document Consistency Audit
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('scam')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 transition-colors ${
              activeTab === 'scam'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            URL &amp; Message Scam Check ({reports.length})
          </button>
        </div>
      }
    >
      <PageTransition>
        {activeTab === 'documents' ? (
          <div className="space-y-6">
            {/* Mandatory Limitation & Non-Fraud Disclosure Banner */}
            <div className="rounded-2xl bg-indigo-500/10 border border-indigo-500/25 p-4 flex items-start gap-3">
              <Info className="w-4 h-4 text-indigo-300 shrink-0 mt-0.5" />
              <div className="space-y-1 text-xs text-slate-300 leading-relaxed">
                <p className="font-semibold text-white">
                  Verification Scope &amp; Honest Limitation Notice
                </p>
                <p>{TRUSTGUARD_LIMITATION_NOTICE}</p>
                <p className="text-slate-400">{TRUSTGUARD_DISCLAIMER}</p>
              </div>
            </div>

            {/* Control Bar + Audit Snapshot Selector */}
            <div className="surface-card p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-white font-display">
                  Document Consistency &amp; Risk Intelligence
                </h2>
                <p className="text-xs text-slate-400">
                  Audits identity, academic marksheet totals, income, category, residence, and readability across your uploaded files, profile, and scholarship rules.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {assessments.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <History className="w-4 h-4 text-slate-400 shrink-0" />
                    <select
                      aria-label="Select TrustGuard audit snapshot"
                      value={selectedSnapshotId}
                      onChange={(e) => setSelectedSnapshotId(e.target.value)}
                      className="input-midnight px-3 py-2 text-xs"
                    >
                      <option value="latest">
                        Latest Saved ({new Date(assessments[0].createdAt).toLocaleString('en-IN')})
                      </option>
                      {assessments.slice(1, 10).map((snap) => (
                        <option key={snap.id} value={snap.id}>
                          {new Date(snap.createdAt).toLocaleString('en-IN')} · {snap.overallVerificationStatus}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => void handleRunAudit(false)}
                  disabled={analyzing || loadingWorkspace}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-xl disabled:opacity-50 whitespace-nowrap"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${analyzing ? 'animate-spin' : ''}`} />
                  <span>{analyzing ? 'Auditing...' : 'Run Verification Audit'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleRunAudit(true)}
                  disabled={analyzing || loadingWorkspace}
                  className="btn-primary-gradient inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl disabled:opacity-50 whitespace-nowrap"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Audit + AI Risk Briefing</span>
                </button>
              </div>
            </div>

            {/* Stale Snapshot Banner */}
            {isSnapshotStale && !isViewingHistorical && (
              <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start gap-2.5 text-xs text-amber-200">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-amber-100">
                      Documents or profile records changed since your last saved TrustGuard audit.
                    </p>
                    <p className="text-amber-200/80 mt-0.5">
                      Re-run verification to refresh findings and update resolution history.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRunAudit(false)}
                  disabled={analyzing}
                  className="px-3.5 py-2 text-xs font-semibold text-amber-950 bg-amber-300 hover:bg-amber-200 rounded-xl whitespace-nowrap shrink-0"
                >
                  Re-Run Verification Now
                </button>
              </div>
            )}

            {isViewingHistorical && (
              <div className="p-3.5 rounded-xl bg-slate-800/70 border border-slate-700 flex items-center justify-between gap-3 text-xs text-slate-200">
                <span>
                  Viewing historical audit snapshot from{' '}
                  <strong className="text-white">
                    {new Date(displayedAssessment!.createdAt).toLocaleString('en-IN')}
                  </strong>
                  . Review note editing is locked on archived snapshots.
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedSnapshotId('latest')}
                  className="font-semibold text-indigo-300 hover:text-indigo-200 hover:underline shrink-0"
                >
                  Return to latest snapshot
                </button>
              </div>
            )}

            {docError && (
              <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-sm text-rose-200 flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                <span>{docError}</span>
              </div>
            )}

            {statusNotice && (
              <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-start gap-2.5">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
                <span>{statusNotice}</span>
              </div>
            )}

            {loadingWorkspace ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <SkeletonCard className="h-32" />
                <SkeletonCard className="h-32" />
                <SkeletonCard className="h-32" />
                <SkeletonCard className="h-32" />
              </div>
            ) : !displayedAssessment ? (
              <div className="surface-card p-8 text-sm text-slate-400">
                Sign in to run TrustGuard verification. Note: new document file uploads are temporarily paused during public beta, while existing document audits and scholarship scam/authenticity checks remain active.
              </div>
            ) : (
              <>
                {/* 4-Card Summary Bar */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="surface-card p-5">
                    <p className="text-xs font-medium text-slate-400">Overall Verification Status</p>
                    <p
                      className={`text-base font-bold font-display mt-1.5 ${getVerificationStatusClass(
                        displayedAssessment.overallVerificationStatus
                      )}`}
                    >
                      {displayedAssessment.overallVerificationStatus}
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1 font-mono-num">
                      Engine {displayedAssessment.analysisVersion}
                    </p>
                  </div>

                  <div className="surface-card p-5 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-slate-400">Documents Analyzed</p>
                      <p className="text-2xl font-bold text-white font-mono-num mt-1.5">
                        <AnimatedCounter value={displayedAssessment.documentsAnalyzedCount} /> /{' '}
                        <AnimatedCounter value={displayedAssessment.documentsTotalCount} />
                      </p>
                      <p className="text-[11px] text-slate-400 mt-1">
                        {displayedAssessment.documentsTotalCount === 0
                          ? 'No documents uploaded yet'
                          : `${verifiedRecordCount} verified against records`}
                      </p>
                    </div>
                    {totalDocsForRing > 0 && (
                      <CircularProgressRing
                        percent={verifiedPercent}
                        size={56}
                        strokeWidth={5}
                        tone={
                          verifiedPercent >= 80
                            ? 'emerald'
                            : verifiedPercent >= 40
                              ? 'amber'
                              : 'rose'
                        }
                      />
                    )}
                  </div>

                  <div className="surface-card p-5">
                    <p className="text-xs font-medium text-slate-400">Critical &amp; High Risks</p>
                    <p className="text-2xl font-bold text-white font-mono-num mt-1.5">
                      <AnimatedCounter
                        value={
                          displayedAssessment.severityCounts.critical +
                          displayedAssessment.severityCounts.high
                        }
                      />
                    </p>
                    <p className="text-[11px] text-slate-400 mt-1 font-mono-num">
                      {displayedAssessment.severityCounts.critical} Critical ·{' '}
                      {displayedAssessment.severityCounts.high} High ·{' '}
                      {displayedAssessment.severityCounts.medium} Medium ·{' '}
                      {displayedAssessment.severityCounts.low} Low
                    </p>
                  </div>

                  <div className="surface-card p-5">
                    <p className="text-xs font-medium text-slate-400">Audit Snapshot Status</p>
                    <p className="text-sm font-semibold text-white mt-1.5 font-mono-num">
                      {latestSaved
                        ? new Date(displayedAssessment.updatedAt).toLocaleString('en-IN')
                        : 'Live Preview (Unsaved)'}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-1">
                      {latestSaved
                        ? 'Click Run Verification Audit to append a new snapshot.'
                        : 'Click Run Verification Audit to save this snapshot.'}
                    </p>
                  </div>
                </div>

                {/* Change Summary & Resolved Findings Drawer */}
                {displayedAssessment.changeSummary && (
                  <div className="surface-card p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div className="flex flex-wrap items-center gap-3 text-slate-300 font-mono-num">
                        <span className="font-semibold text-white">Diff vs Previous Audit:</span>
                        <span className="text-amber-300 font-semibold">
                          {displayedAssessment.changeSummary.newFindingIds.length} New
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="text-emerald-300 font-semibold">
                          {displayedAssessment.changeSummary.resolvedFindingIds.length} Resolved
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {displayedAssessment.changeSummary.unchangedFindingIds.length} Unchanged
                        </span>
                      </div>

                      {displayedAssessment.changeSummary.resolvedFindingTitles.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowResolvedDrawer((v) => !v)}
                          className="inline-flex items-center gap-1 font-semibold text-emerald-300 hover:underline"
                        >
                          <span>
                            {showResolvedDrawer ? 'Hide' : 'View'} Resolved Issues (
                            {displayedAssessment.changeSummary.resolvedFindingTitles.length})
                          </span>
                          {showResolvedDrawer ? (
                            <ChevronUp className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>

                    <AnimatePresence>
                      {showResolvedDrawer &&
                        displayedAssessment.changeSummary.resolvedFindingTitles.length > 0 && (
                          <motion.ul
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className="border-t border-slate-800 pt-2.5 space-y-1 text-xs text-emerald-200"
                          >
                            {displayedAssessment.changeSummary.resolvedFindingTitles.map(
                              (title, idx) => (
                                <li key={`${title}-${idx}`} className="flex items-center gap-2">
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                  <span>Resolved: {title}</span>
                                </li>
                              )
                            )}
                          </motion.ul>
                        )}
                    </AnimatePresence>
                  </div>
                )}

                {/* Gemini AI Risk Briefing */}
                {displayedAssessment.aiSummary && (
                  <div className="surface-card p-6 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-white font-display flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-indigo-400" />
                        <span>Grounded AI Verification Briefing</span>
                      </h3>
                      <span className="text-[11px] text-slate-400">
                        Grounded in deterministic TrustGuard findings
                      </span>
                    </div>
                    <p className="text-sm text-slate-300 whitespace-pre-line leading-relaxed">
                      {displayedAssessment.aiSummary}
                    </p>
                  </div>
                )}

                {/* Main 2-Column Workspace */}
                <div className="grid lg:grid-cols-12 gap-6">
                  {/* Left 7 Cols: Discrepancy & Risk Findings */}
                  <div className="lg:col-span-7 space-y-4">
                    <div className="surface-card p-6 space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
                        <div>
                          <h3 className="text-base font-semibold text-white font-display">
                            Risk &amp; Consistency Findings ({filteredFindings.length})
                          </h3>
                          <p className="text-xs text-slate-400">
                            Evidence values are read-only; record your review status and correction notes below each finding.
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            aria-label="Filter findings by severity"
                            value={severityFilter}
                            onChange={(e) => setSeverityFilter(e.target.value as SeverityFilter)}
                            className="input-midnight px-2.5 py-1.5 text-xs"
                          >
                            <option value="All">All Severities</option>
                            <option value="Critical">Critical</option>
                            <option value="High">High</option>
                            <option value="Medium">Medium</option>
                            <option value="Low">Low</option>
                            <option value="Informational">Informational</option>
                          </select>

                          {displayedAssessment.changeSummary && (
                            <select
                              aria-label="Filter findings by audit diff state"
                              value={changeFilter}
                              onChange={(e) => setChangeFilter(e.target.value as ChangeFilter)}
                              className="input-midnight px-2.5 py-1.5 text-xs"
                            >
                              <option value="All">All States</option>
                              <option value="New">New Since Last Audit</option>
                              <option value="Unchanged">Unchanged</option>
                            </select>
                          )}
                        </div>
                      </div>

                      {displayedAssessment.documentsTotalCount === 0 ? (
                        <div className="py-6 text-sm text-slate-300 space-y-3">
                          <p>
                            No uploaded documents are on file yet. New document file uploads are temporarily paused during public beta, while Scholarship Scam &amp; Authenticity Check remains fully available in the tabs above.
                          </p>
                          <Link
                            to="/documents"
                            className="btn-primary-gradient inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            <span>View Document Intelligence</span>
                          </Link>
                        </div>
                      ) : filteredFindings.length === 0 ? (
                        <div className="py-6 text-sm text-emerald-200 flex items-center gap-2.5">
                          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                          <span>
                            No findings match the current filter across your analyzed documents.
                          </span>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {filteredFindings.map((finding) => (
                            <div
                              key={finding.findingId}
                              className="p-4 rounded-xl bg-[#070C1B]/75 border border-slate-800 space-y-3"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="space-y-1">
                                  <div className="flex flex-wrap items-center gap-2 text-xs">
                                    <span
                                      className={`font-bold ${getSeverityTextClass(finding.severity)}`}
                                    >
                                      {finding.severity} Risk
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span className="font-medium text-slate-300">
                                      {finding.category}
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span className="text-slate-400">
                                      Confidence: {finding.extractionConfidence}
                                    </span>
                                    {finding.changeState && (
                                      <>
                                        <span aria-hidden="true">·</span>
                                        <span
                                          className={
                                            finding.changeState === 'New'
                                              ? 'font-semibold text-indigo-300'
                                              : 'text-slate-400'
                                          }
                                        >
                                          {finding.changeState}
                                        </span>
                                      </>
                                    )}
                                  </div>
                                  <h4 className="text-sm font-semibold text-white">
                                    {finding.title}
                                  </h4>
                                </div>

                                <span className="text-xs font-semibold text-slate-300">
                                  {finding.reviewStatus}
                                </span>
                              </div>

                              <p className="text-xs text-slate-300 leading-relaxed">
                                {finding.description}
                              </p>

                              {/* Side-by-side conflicting evidence values */}
                              {finding.conflictingValues.length > 0 && (
                                <div className="bg-[#0B1224] border border-slate-800 rounded-lg divide-y divide-slate-800/80">
                                  {finding.conflictingValues.map((cv, idx) => (
                                    <div
                                      key={`${finding.findingId}-cv-${idx}`}
                                      className="px-3 py-2 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-1"
                                    >
                                      <span className="text-slate-400">
                                        <strong className="text-slate-200">{cv.sourceLabel}</strong> ·{' '}
                                        {cv.fieldName}
                                      </span>
                                      <span className="font-mono-num font-medium text-white">
                                        {cv.value}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}

                              <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                                <span>Source: {finding.evidenceSource}</span>
                                {finding.affectedDocuments.length > 0 && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span>
                                      Files:{' '}
                                      {finding.affectedDocuments.map((d) => d.fileName).join(', ')}
                                    </span>
                                  </>
                                )}
                              </div>

                              {finding.relatedScholarshipTitles &&
                                finding.relatedScholarshipTitles.length > 0 && (
                                  <div className="text-xs text-slate-300">
                                    <span className="font-semibold text-slate-200">
                                      Impacted Schemes:{' '}
                                    </span>
                                    {finding.relatedScholarshipTitles.map((title, idx) => {
                                      const schId = finding.relatedScholarshipIds?.[idx];
                                      return (
                                        <span key={`${finding.findingId}-sch-${idx}`}>
                                          {idx > 0 ? ', ' : ''}
                                          {schId ? (
                                            <Link
                                              to={`/scholarships/${schId}`}
                                              className="text-indigo-300 hover:text-indigo-200 hover:underline font-medium"
                                            >
                                              {title}
                                            </Link>
                                          ) : (
                                            title
                                          )}
                                        </span>
                                      );
                                    })}
                                  </div>
                                )}

                              <div className="p-3 rounded-lg bg-[#0B1224] border border-slate-800 text-xs text-slate-300">
                                <span className="font-semibold text-white">
                                  Recommended Action:{' '}
                                </span>
                                {finding.recommendedAction}
                              </div>

                              {latestSaved && !isViewingHistorical && (
                                <div className="pt-2 border-t border-slate-800/80 space-y-2.5">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {(
                                      [
                                        'Unreviewed',
                                        'Reviewed',
                                        'Correction Planned',
                                      ] as TrustGuardReviewStatus[]
                                    ).map((st) => (
                                      <button
                                        key={st}
                                        type="button"
                                        disabled={savingFindingId === finding.findingId}
                                        onClick={() =>
                                          void handleUpdateFindingReview(finding.findingId, st)
                                        }
                                        className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg border whitespace-nowrap transition-colors ${
                                          finding.reviewStatus === st
                                            ? 'bg-indigo-600 text-white border-indigo-500'
                                            : 'bg-[#0B1224] text-slate-300 border-slate-800 hover:bg-slate-800'
                                        }`}
                                      >
                                        {st}
                                      </button>
                                    ))}
                                  </div>
                                  <div className="flex gap-2">
                                    <input
                                      type="text"
                                      value={noteDrafts[finding.findingId] ?? ''}
                                      onChange={(e) =>
                                        setNoteDrafts((prev) => ({
                                          ...prev,
                                          [finding.findingId]: e.target.value,
                                        }))
                                      }
                                      placeholder="Add correction note (e.g., Applied for e-District income update)..."
                                      className="input-midnight flex-1 px-3 py-1.5 text-xs"
                                    />
                                    <button
                                      type="button"
                                      disabled={savingFindingId === finding.findingId}
                                      onClick={() =>
                                        void handleUpdateFindingReview(
                                          finding.findingId,
                                          finding.reviewStatus === 'Unreviewed'
                                            ? 'Reviewed'
                                            : finding.reviewStatus
                                        )
                                      }
                                      className="px-3 py-1.5 text-xs font-semibold text-indigo-200 bg-indigo-500/15 border border-indigo-500/30 hover:bg-indigo-500/25 rounded-lg whitespace-nowrap"
                                    >
                                      {savingFindingId === finding.findingId
                                        ? 'Saving...'
                                        : 'Save Note'}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right 5 Cols: Document-Wise Matrix + Corrective Actions + AI Companion Shortcuts */}
                  <div className="lg:col-span-5 space-y-6">
                    {/* Document-Wise Verification Matrix */}
                    <div className="surface-card p-6 space-y-4">
                      <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                        <h3 className="text-base font-semibold text-white font-display">
                          Document-Wise Verification Status
                        </h3>
                        <Link
                          to="/documents"
                          className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 hover:underline"
                        >
                          Manage uploads
                        </Link>
                      </div>

                      {displayedAssessment.documentResults.length === 0 ? (
                        <p className="text-xs text-slate-400">
                          No documents uploaded yet.
                        </p>
                      ) : (
                        <div className="divide-y divide-slate-800/80">
                          {displayedAssessment.documentResults.map((docRes) => (
                            <div key={docRes.documentId} className="py-3.5 first:pt-0 last:pb-0 space-y-1.5">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-sm font-semibold text-white truncate">
                                    {docRes.fileName}
                                  </p>
                                  <p className="text-xs text-slate-400">
                                    {docRes.documentType}
                                    {docRes.overallConfidence
                                      ? ` · OCR ${docRes.overallConfidence}`
                                      : ''}
                                    {docRes.findingCount > 0
                                      ? ` · ${docRes.findingCount} finding(s)`
                                      : ''}
                                  </p>
                                </div>
                                {(() => {
                                  const fullDoc = documents.find((d) => d.id === docRes.documentId);
                                  const hasBinary = Boolean(
                                    fullDoc &&
                                      (fullDoc.storageProvider === 'firebase-storage' ||
                                        fullDoc.storageProvider === 'private-vault') &&
                                      fullDoc.storagePath !== 'temporary-in-memory'
                                  );
                                  return (
                                    <button
                                      type="button"
                                      disabled={previewBusyId === docRes.documentId || !hasBinary}
                                      title={
                                        hasBinary
                                          ? 'Preview stored document'
                                          : 'Preview unavailable (analyzed in temporary memory only)'
                                      }
                                      onClick={() => {
                                        void handlePreviewPrivateDoc(
                                          docRes.documentId,
                                          docRes.fileName,
                                          fullDoc?.mimeType
                                        );
                                      }}
                                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-lg shrink-0 whitespace-nowrap disabled:opacity-45 disabled:cursor-not-allowed"
                                    >
                                      <Eye className="w-3 h-3" />
                                      <span>
                                        {previewBusyId === docRes.documentId
                                          ? 'Loading...'
                                          : hasBinary
                                            ? 'Preview'
                                            : 'Temp Only'}
                                      </span>
                                    </button>
                                  );
                                })()}
                              </div>

                              <p
                                className={`text-xs font-semibold ${getVerificationStatusClass(
                                  docRes.verificationStatus
                                )}`}
                              >
                                {docRes.verificationStatus}
                              </p>
                              <p className="text-xs text-slate-400 leading-relaxed">
                                {docRes.summaryNote}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Corrective Action Checklist */}
                    <div className="surface-card p-6 space-y-3">
                      <h3 className="text-base font-semibold text-white font-display">
                        Prioritized Corrective Actions
                      </h3>
                      {displayedAssessment.correctiveActions.length === 0 ? (
                        <p className="text-xs text-slate-400">
                          No corrective actions required for your current document records.
                        </p>
                      ) : (
                        <ol className="space-y-2 text-xs text-slate-300 list-decimal pl-4">
                          {displayedAssessment.correctiveActions.map((act, idx) => (
                            <li key={`ca-${idx}`} className="leading-relaxed">
                              {act}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>

                    {/* AI Companion Grounded Verification Prompts */}
                    <div className="surface-card p-6 space-y-3">
                      <h3 className="text-sm font-semibold text-white font-display flex items-center gap-2">
                        <MessageSquareText className="w-4 h-4 text-indigo-400" />
                        <span>Ask GRANTLY AI Companion About These Results</span>
                      </h3>
                      <div className="space-y-2">
                        {TRUSTGUARD_COMPANION_PROMPTS.map((q) => (
                          <Link
                            key={q}
                            to={`/companion?prompt=${encodeURIComponent(q)}`}
                            className="block px-3.5 py-2.5 text-xs font-medium text-slate-300 bg-[#070C1B]/75 hover:bg-[#101933] hover:text-white border border-slate-800 hover:border-indigo-500/40 rounded-xl transition-colors"
                          >
                            {q}
                          </Link>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          /* URL & Forwarded Message Scam Screening Tab */
          <div className="space-y-6">
            <form onSubmit={handleInspectAndReport} className="surface-card p-6 space-y-4">
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-white font-display">
                  Inspect Scholarship URL or Forwarded Message
                </h2>
                <p className="text-xs text-slate-400">
                  Legitimate Indian government and foundation scholarships never charge registration fees, UPI transfers, or OTP verification. Submit suspicious links below for AI screening and admin review.
                </p>
              </div>

              {scamError && (
                <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-sm text-rose-200 flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                  <span>{scamError}</span>
                </div>
              )}

              <div>
                <label htmlFor="tg-input" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Suspicious URL, Portal Domain, or Message Text
                </label>
                <textarea
                  id="tg-input"
                  rows={3}
                  required
                  value={submittedUrlOrText}
                  onChange={(e) => setSubmittedUrlOrText(e.target.value)}
                  placeholder="Paste link (e.g. https://...) or SMS/WhatsApp scholarship message..."
                  className="input-midnight w-full px-3.5 py-2.5 text-sm"
                />
              </div>

              <label className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={claimsFeeOrDeposit}
                  onChange={(e) => setClaimsFeeOrDeposit(e.target.checked)}
                  className="rounded border-slate-700 bg-[#070C1B] text-indigo-500"
                />
                <span>
                  This source asks for a processing fee, security deposit, UPI payment, or bank OTP
                </span>
              </label>

              <button
                type="submit"
                disabled={scamBusy || submittedUrlOrText.trim().length < 3}
                className="btn-primary-gradient inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl disabled:opacity-50"
              >
                <ShieldCheck className="w-4 h-4" />
                <span>{scamBusy ? 'Scanning...' : 'Run TrustGuard Check & Submit Report'}</span>
              </button>
            </form>

            <div className="surface-card p-6 space-y-4">
              <h2 className="text-base font-semibold text-white font-display">
                Submitted TrustGuard Reports
              </h2>
              {reports.length === 0 ? (
                <p className="text-sm text-slate-400">No verification reports submitted yet.</p>
              ) : (
                <div className="space-y-3">
                  {reports.map((r) => (
                    <div
                      key={r.id}
                      className="p-4 rounded-xl bg-[#070C1B]/75 border border-slate-800 space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span
                          className={`font-semibold inline-flex items-center gap-1.5 ${
                            r.riskLevel === 'High Risk'
                              ? 'text-rose-300'
                              : r.riskLevel === 'Caution'
                                ? 'text-amber-300'
                                : 'text-emerald-300'
                          }`}
                        >
                          <ShieldAlert className="w-4 h-4" />
                          <span>{r.riskLevel}</span>
                        </span>
                        <span className="text-slate-400 font-mono-num">
                          Status: {r.status} · {new Date(r.createdAt).toLocaleDateString('en-IN')}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-white break-all">
                        {r.submittedUrlOrText}
                      </p>
                      {r.analysisSummary && (
                        <p className="text-xs text-slate-300 leading-relaxed">{r.analysisSummary}</p>
                      )}
                      {r.adminNotes && (
                        <p className="text-xs text-indigo-300 pt-1">
                          Admin Review Note: {r.adminNotes}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </PageTransition>

      {/* Private Vault Document Preview Modal */}
      {previewDoc && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${previewDoc.fileName}`}
          className="fixed inset-0 z-50 bg-[#02050D]/80 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div className="surface-elevated w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">
                  {previewDoc.fileName}
                </p>
                <p className="text-[11px] text-slate-400">
                  Private Document Preview · Authenticated Session Only
                </p>
              </div>
              <button
                type="button"
                onClick={closePreview}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close document preview"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 bg-[#070C1B] overflow-auto p-4 flex items-center justify-center min-h-[420px]">
              {previewDoc.mimeType.includes('pdf') ? (
                <iframe
                  src={previewDoc.objectUrl}
                  title={previewDoc.fileName}
                  className="w-full h-[70vh] rounded-lg bg-white border border-slate-800"
                />
              ) : (
                <img
                  src={previewDoc.objectUrl}
                  alt={previewDoc.fileName}
                  className="max-w-full max-h-[72vh] object-contain rounded-lg border border-slate-800 bg-[#0B1224]"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
