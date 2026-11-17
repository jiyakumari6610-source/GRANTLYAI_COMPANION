import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  FileText,
  HelpCircle,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
  UploadCloud,
  X,
  XCircle,
} from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import {
  AnimatedCounter,
  CircularProgressRing,
  PageTransition,
  StaggerGrid,
  StaggerItem,
} from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { deleteProtected, fetchProtectedBlob, getProtectedApi, postProtectedAi } from '../lib/apiClient.ts';
import { compareDocumentsAgainstScholarship } from '../lib/documentComparison.ts';
import {
  buildMarksheetExtractedFields,
  recalculateMarksheetWithUserConfirmation,
} from '../lib/marksheetCalculator.ts';
import {
  createDocumentRecord,
  deleteDocumentWithAnalyses,
  getDocumentAnalyses,
  getDocuments,
  getScholarships,
  makeId,
  saveDocumentAnalysis,
  saveProfile,
  updateDocumentFields,
} from '../lib/firestoreRepo.ts';
import {
  DOCUMENT_CATEGORIES,
  type DocumentAnalysis,
  type DocumentProcessingStatus,
  type DocumentRecord,
  type ExtractedDocumentField,
  type MarksheetExtractionSummary,
  type MarksheetSubjectRole,
  type Scholarship,
} from '../types/database.ts';

const MAX_CLIENT_BYTES = 8 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png'];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read selected file from disk.'));
    reader.readAsDataURL(file);
  });
}

function isSupportedFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  const extOk = ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  const mimeOk =
    file.type === 'application/pdf' ||
    file.type === 'image/jpeg' ||
    file.type === 'image/jpg' ||
    file.type === 'image/png';
  return extOk || mimeOk;
}

function getProcessingStatusClass(status?: DocumentProcessingStatus): string {
  switch (status) {
    case 'Completed':
      return 'text-emerald-300 font-semibold';
    case 'Needs Review':
      return 'text-amber-300 font-semibold';
    case 'Failed':
      return 'text-rose-300 font-semibold';
    case 'Processing':
    case 'Pending':
      return 'text-indigo-300 font-semibold';
    default:
      return 'text-slate-400 font-medium';
  }
}

interface ServerProcessResponse {
  processingStatus: 'Completed' | 'Needs Review';
  verificationStatus: 'Analyzed' | 'Needs Attention';
  extractionMethod: string;
  pageCount: number;
  rawTextPreview: string;
  disclaimer: string;
  analysis: {
    detectedType: string;
    readabilityStatus: 'Readable' | 'Partially Readable' | 'Unreadable';
    issuingAuthority: string;
    validityNotes: string;
    expiryWarning: string;
    overallConfidence: 'High' | 'Medium' | 'Low';
    extractedFields: ExtractedDocumentField[];
    marksheetSummary?: MarksheetExtractionSummary;
    missingFields: string[];
    unreadableFields: string[];
    profileMismatches: string[];
    manualVerificationItems: string[];
    issuesFound: string[];
    recommendations: string[];
    readinessVerdict: 'Ready' | 'Needs Clarification' | 'Incomplete';
  };
}

export default function DocumentIntelligencePage() {
  const { user, profile, refreshProfile, getIdToken } = useAuth();
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [analyses, setAnalyses] = useState<DocumentAnalysis[]>([]);
  const [scholarships, setScholarships] = useState<Scholarship[]>([]);
  const [selectedScholarshipId, setSelectedScholarshipId] = useState<string>('');

  const [documentType, setDocumentType] = useState<string>(DOCUMENT_CATEGORIES[1]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeDocIds, setActiveDocIds] = useState<Set<string>>(new Set());
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<{
    fileName: string;
    mimeType: string;
    objectUrl: string;
  } | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);

  // Per-document Q&A state
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [qaHistory, setQaHistory] = useState<
    Record<string, Array<{ question: string; answer: string }>>
  >({});
  const [qaBusyDocId, setQaBusyDocId] = useState<string | null>(null);

  // Marksheet subject selection confirmation state
  const [editingSubjectDocId, setEditingSubjectDocId] = useState<string | null>(null);
  const [subjectDrafts, setSubjectDrafts] = useState<
    Record<
      string,
      Array<{
        subjectName: string;
        subjectCategory: MarksheetSubjectRole;
        maxMarks: string;
      }>
    >
  >({});
  const [confirmingDocId, setConfirmingDocId] = useState<string | null>(null);
  const [syncingProfileDocId, setSyncingProfileDocId] = useState<string | null>(null);

  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [replaceTargetDoc, setReplaceTargetDoc] = useState<DocumentRecord | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [storageStatus, setStorageStatus] = useState<{
    checked: boolean;
    uploadAvailable: boolean;
    reason: string;
  }>({
    checked: false,
    uploadAvailable: false,
    reason: 'Checking document storage availability...',
  });

  useEffect(() => {
    if (!user) return;
    let active = true;
    Promise.all([
      getDocuments(user.uid),
      getDocumentAnalyses(user.uid),
      getScholarships(),
    ]).then(([docsList, analysesList, schRes]) => {
      if (!active) return;
      setDocuments(docsList);
      setAnalyses(analysesList);
      setScholarships(schRes.items);
      if (schRes.items[0]) {
        setSelectedScholarshipId(schRes.items[0].id);
      }
      if (docsList[0]) {
        setExpandedDocId(docsList[0].id);
      }
    });

    getIdToken()
      .then((token) =>
        getProtectedApi<{ uploadAvailable: boolean; reason: string }>(
          '/api/documents/storage-status',
          token
        )
      )
      .then((res) => {
        if (!active) return;
        setStorageStatus({
          checked: true,
          uploadAvailable: Boolean(res.uploadAvailable),
          reason:
            res.reason ||
            'Document upload and binary storage are temporarily unavailable during the current public beta.',
        });
      })
      .catch(() => {
        if (!active) return;
        setStorageStatus({
          checked: true,
          uploadAvailable: false,
          reason:
            'Document upload and binary storage are temporarily unavailable during the current public beta.',
        });
      });

    return () => {
      active = false;
    };
  }, [user, getIdToken]);

  useEffect(() => {
    return () => {
      if (previewState?.objectUrl) {
        URL.revokeObjectURL(previewState.objectUrl);
      }
    };
  }, [previewState]);

  const latestAnalysisByDoc = useMemo(() => {
    const map = new Map<string, DocumentAnalysis>();
    for (const ana of analyses) {
      const existing = map.get(ana.documentId);
      if (!existing || ana.createdAt > existing.createdAt) {
        map.set(ana.documentId, ana);
      }
    }
    return map;
  }, [analyses]);

  const selectedScholarship = useMemo(
    () => scholarships.find((s) => s.id === selectedScholarshipId) ?? null,
    [scholarships, selectedScholarshipId]
  );

  const scholarshipComparison = useMemo(() => {
    if (!selectedScholarship) return null;
    return compareDocumentsAgainstScholarship(
      selectedScholarship,
      documents,
      analyses,
      profile
    );
  }, [selectedScholarship, documents, analyses, profile]);

  const metrics = useMemo(() => {
    const total = documents.length;
    const completed = documents.filter(
      (d) => d.processingStatus === 'Completed' || (!d.processingStatus && d.verificationStatus === 'Analyzed')
    ).length;
    const needsReview = documents.filter(
      (d) =>
        d.processingStatus === 'Needs Review' ||
        d.processingStatus === 'Failed' ||
        (!d.processingStatus && d.verificationStatus === 'Needs Attention')
    ).length;
    const missingRequired = scholarshipComparison?.missingCount ?? 0;
    return { total, completed, needsReview, missingRequired };
  }, [documents, scholarshipComparison]);

  const markDocBusy = (docId: string, isBusy: boolean) => {
    setActiveDocIds((prev) => {
      const next = new Set(prev);
      if (isBusy) next.add(docId);
      else next.delete(docId);
      return next;
    });
  };

  const runProcessingPipeline = async (
    docRecord: DocumentRecord,
    token: string
  ): Promise<void> => {
    markDocBusy(docRecord.id, true);
    try {
      const processingTime = new Date().toISOString();
      await updateDocumentFields(docRecord.id, {
        processingStatus: 'Processing',
        errorDetails: '',
        updatedAt: processingTime,
      });
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === docRecord.id
            ? { ...d, processingStatus: 'Processing', errorDetails: '', updatedAt: processingTime }
            : d
        )
      );

      const res = await postProtectedAi<ServerProcessResponse>(
        `/api/documents/${docRecord.id}/process`,
        token,
        {
          documentType: docRecord.documentType,
          profile,
          scholarship: selectedScholarship,
        }
      );

      const analyzedAt = new Date().toISOString();
      const analysisRecord: DocumentAnalysis = {
        id: makeId('ana'),
        userId: docRecord.userId,
        documentId: docRecord.id,
        detectedType: res.analysis.detectedType,
        readabilityStatus: res.analysis.readabilityStatus,
        extractionMethod: res.extractionMethod,
        pageCount: res.pageCount,
        rawTextPreview: res.rawTextPreview,
        issuingAuthority: res.analysis.issuingAuthority,
        validityNotes: res.analysis.validityNotes,
        expiryWarning: res.analysis.expiryWarning,
        overallConfidence: res.analysis.overallConfidence,
        extractedFields: res.analysis.extractedFields,
        ...(res.analysis.marksheetSummary
          ? { marksheetSummary: res.analysis.marksheetSummary }
          : {}),
        missingFields: res.analysis.missingFields,
        unreadableFields: res.analysis.unreadableFields,
        profileMismatches: res.analysis.profileMismatches,
        manualVerificationItems: res.analysis.manualVerificationItems,
        issuesFound: res.analysis.issuesFound,
        recommendations: res.analysis.recommendations,
        readinessVerdict: res.analysis.readinessVerdict,
        disclaimer: res.disclaimer,
        createdAt: analyzedAt,
      };

      await saveDocumentAnalysis(analysisRecord);
      await updateDocumentFields(docRecord.id, {
        verificationStatus: res.verificationStatus,
        processingStatus: res.processingStatus,
        extractionMethod: res.extractionMethod,
        pageCount: res.pageCount,
        lastAnalyzedAt: analyzedAt,
        errorDetails: '',
        updatedAt: analyzedAt,
      });

      setAnalyses((prev) => [analysisRecord, ...prev]);
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === docRecord.id
            ? {
                ...d,
                verificationStatus: res.verificationStatus,
                processingStatus: res.processingStatus,
                extractionMethod: res.extractionMethod,
                pageCount: res.pageCount,
                lastAnalyzedAt: analyzedAt,
                errorDetails: '',
                updatedAt: analyzedAt,
              }
            : d
        )
      );
      setExpandedDocId(docRecord.id);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Document processing failed.';
      const failedAt = new Date().toISOString();
      await updateDocumentFields(docRecord.id, {
        verificationStatus: 'Needs Attention',
        processingStatus: 'Failed',
        errorDetails: errMsg.slice(0, 750),
        updatedAt: failedAt,
      }).catch(() => undefined);

      setDocuments((prev) =>
        prev.map((d) =>
          d.id === docRecord.id
            ? {
                ...d,
                verificationStatus: 'Needs Attention',
                processingStatus: 'Failed',
                errorDetails: errMsg,
                updatedAt: failedAt,
              }
            : d
        )
      );
      throw err;
    } finally {
      markDocBusy(docRecord.id, false);
    }
  };

  const handleUploadAndAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || selectedFiles.length === 0) return;
    if (!storageStatus.uploadAvailable) {
      setError(storageStatus.reason);
      return;
    }

    setError(null);
    setBusy(true);

    try {
      const token = await getIdToken();
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        if (!isSupportedFile(file)) {
          throw new Error(
            `"${file.name}" is unsupported. Only PDF, JPG, JPEG, and PNG documents are accepted.`
          );
        }
        if (file.size > MAX_CLIENT_BYTES) {
          throw new Error(`"${file.name}" exceeds the 8 MB upload limit.`);
        }

        setStatusNote(
          `[${i + 1}/${selectedFiles.length}] Validating & storing "${file.name}" securely...`
        );
        const docId = makeId('doc');
        const base64Data = await fileToBase64(file);

        const uploadRes = await postProtectedAi<{
          storagePath: string;
          storageProvider: 'firebase-storage' | 'private-vault';
          mimeType: string;
          fileSizeBytes: number;
        }>('/api/documents/upload', token, {
          docId,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          base64Data,
        });

        const now = new Date().toISOString();
        const docRecord: DocumentRecord = {
          id: docId,
          userId: user.uid,
          documentType,
          fileName: file.name,
          mimeType: uploadRes.mimeType,
          fileSizeBytes: uploadRes.fileSizeBytes,
          storagePath: uploadRes.storagePath,
          downloadUrl: '',
          storageProvider: uploadRes.storageProvider,
          verificationStatus: 'Uploaded',
          processingStatus: 'Pending',
          createdAt: now,
          updatedAt: now,
        };

        await createDocumentRecord(docRecord);
        setDocuments((prev) => [docRecord, ...prev]);

        setStatusNote(
          `[${i + 1}/${selectedFiles.length}] Running PDF/OCR extraction & Gemini analysis for "${file.name}"...`
        );
        await runProcessingPipeline(docRecord, token);
      }

      setSelectedFiles([]);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
      setStatusNote(null);
    } catch (err) {
      setStatusNote(null);
      setError(err instanceof Error ? err.message : 'Document upload or processing failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleReplaceFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = replaceTargetDoc;
    e.target.value = '';
    setReplaceTargetDoc(null);

    if (!file || !target || !user) return;
    if (!storageStatus.uploadAvailable) {
      setError(storageStatus.reason);
      return;
    }
    if (!isSupportedFile(file)) {
      setError(`"${file.name}" is unsupported. Only PDF, JPG, JPEG, and PNG files are allowed.`);
      return;
    }
    if (file.size > MAX_CLIENT_BYTES) {
      setError(`"${file.name}" exceeds the 8 MB upload limit.`);
      return;
    }

    setError(null);
    setStatusNote(`Replacing "${target.fileName}" with "${file.name}" and re-analyzing...`);
    markDocBusy(target.id, true);

    try {
      const token = await getIdToken();
      const base64Data = await fileToBase64(file);
      const uploadRes = await postProtectedAi<{
        storagePath: string;
        storageProvider: 'firebase-storage' | 'private-vault';
        mimeType: string;
        fileSizeBytes: number;
      }>('/api/documents/upload', token, {
        docId: target.id,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        base64Data,
      });

      const now = new Date().toISOString();
      const updatedDoc: DocumentRecord = {
        ...target,
        fileName: file.name,
        mimeType: uploadRes.mimeType,
        fileSizeBytes: uploadRes.fileSizeBytes,
        storagePath: uploadRes.storagePath,
        downloadUrl: '',
        storageProvider: uploadRes.storageProvider,
        processingStatus: 'Pending',
        verificationStatus: 'Uploaded',
        errorDetails: '',
        updatedAt: now,
      };

      await updateDocumentFields(target.id, {
        fileName: updatedDoc.fileName,
        mimeType: updatedDoc.mimeType,
        fileSizeBytes: updatedDoc.fileSizeBytes,
        storagePath: updatedDoc.storagePath,
        downloadUrl: '',
        storageProvider: updatedDoc.storageProvider,
        processingStatus: 'Pending',
        verificationStatus: 'Uploaded',
        errorDetails: '',
        updatedAt: now,
      });
      setDocuments((prev) => prev.map((d) => (d.id === target.id ? updatedDoc : d)));
      await runProcessingPipeline(updatedDoc, token);
      setStatusNote(null);
    } catch (err) {
      setStatusNote(null);
      setError(err instanceof Error ? err.message : 'Unable to replace document.');
    } finally {
      markDocBusy(target.id, false);
    }
  };

  const handleRetryAnalysis = async (docItem: DocumentRecord) => {
    if (!user || activeDocIds.has(docItem.id)) return;
    setError(null);
    setStatusNote(`Retrying PDF/OCR extraction & analysis for "${docItem.fileName}"...`);
    try {
      const token = await getIdToken();
      await runProcessingPipeline(docItem, token);
      setStatusNote(null);
    } catch (err) {
      setStatusNote(null);
      setError(err instanceof Error ? err.message : 'Retry analysis failed.');
    }
  };

  const handlePreview = async (docItem: DocumentRecord) => {
    if (!user) return;
    setPreviewLoadingId(docItem.id);
    setError(null);
    try {
      const token = await getIdToken();
      const blob = await fetchProtectedBlob(`/api/documents/${docItem.id}/content`, token);
      const objectUrl = URL.createObjectURL(blob);
      setPreviewState({
        fileName: docItem.fileName,
        mimeType: docItem.mimeType || blob.type || 'application/pdf',
        objectUrl,
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Private file preview unavailable. Upload or replace this document to preview.'
      );
    } finally {
      setPreviewLoadingId(null);
    }
  };

  const handleDelete = async (docItem: DocumentRecord) => {
    if (!user) return;
    setError(null);
    try {
      const token = await getIdToken();
      await deleteProtected(`/api/documents/${docItem.id}/file`, token).catch(() => undefined);
      await deleteDocumentWithAnalyses(user.uid, docItem.id);
      setDocuments((prev) => prev.filter((d) => d.id !== docItem.id));
      setAnalyses((prev) => prev.filter((a) => a.documentId !== docItem.id));
      if (expandedDocId === docItem.id) setExpandedDocId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete document securely.');
    }
  };

  const handleAskDocumentQuestion = async (
    e: React.FormEvent,
    docItem: DocumentRecord,
    analysis: DocumentAnalysis
  ) => {
    e.preventDefault();
    const q = (questionDrafts[docItem.id] || '').trim();
    if (!q || !user) return;

    setQaBusyDocId(docItem.id);
    setError(null);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{ answer: string }>(
        `/api/documents/${docItem.id}/ask`,
        token,
        {
          question: q,
          documentMeta: {
            fileName: docItem.fileName,
            documentType: docItem.documentType,
          },
          storedAnalysis: analysis,
          scholarshipContext: selectedScholarship,
        }
      );

      setQaHistory((prev) => ({
        ...prev,
        [docItem.id]: [...(prev[docItem.id] || []), { question: q, answer: res.answer }],
      }));
      setQuestionDrafts((prev) => ({ ...prev, [docItem.id]: '' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to answer question about document.');
    } finally {
      setQaBusyDocId(null);
    }
  };

  const openSubjectConfirmationEditor = (docId: string, summary: MarksheetExtractionSummary) => {
    setSubjectDrafts((prev) => ({
      ...prev,
      [docId]: summary.subjects.map((s) => ({
        subjectName: s.subjectName,
        subjectCategory: s.subjectCategory === 'uncertain' ? 'main' : s.subjectCategory,
        maxMarks: s.maxMarks !== null ? String(s.maxMarks) : '',
      })),
    }));
    setEditingSubjectDocId(docId);
  };

  const handleConfirmSubjectSelection = async (
    docItem: DocumentRecord,
    analysis: DocumentAnalysis
  ) => {
    if (!user || !analysis.marksheetSummary) return;
    const draftRows = subjectDrafts[docItem.id];
    if (!draftRows || draftRows.length === 0) return;

    setConfirmingDocId(docItem.id);
    setError(null);
    try {
      const updatedSummary = recalculateMarksheetWithUserConfirmation(
        analysis.marksheetSummary,
        draftRows.map((row) => ({
          subjectName: row.subjectName,
          subjectCategory: row.subjectCategory,
          maxMarks: row.maxMarks.trim() === '' ? null : Number(row.maxMarks),
        }))
      );

      const genericAggregateRegex =
        /^(board\s*\/\s*university|examination\s*&\s*level|applicable\s*assessment\s*rule|overall\s*|aggregate\s*including|subject\s*selection\s*status|total\s*marks|obtained\s*marks|maximum\s*marks|percentage)/i;
      const baseFields = (analysis.extractedFields || []).filter(
        (f) => !genericAggregateRegex.test(f.fieldName.trim())
      );
      const updatedFields = [...baseFields, ...buildMarksheetExtractedFields(updatedSummary)].slice(
        0,
        60
      );

      const nextProfileMismatches = (analysis.profileMismatches || []).filter(
        (m) => !/academic marks|marksheet aggregate|previousMarksPercent/i.test(m)
      );
      if (
        updatedSummary.mainAggregate &&
        !updatedSummary.requiresUserConfirmation &&
        typeof profile?.previousMarksPercent === 'number' &&
        Math.abs(profile.previousMarksPercent - updatedSummary.mainAggregate.percentage) > 0.5
      ) {
        nextProfileMismatches.push(
          `Student profile academic marks (${profile.previousMarksPercent}%) differ from ${updatedSummary.mainAggregate.label} (${updatedSummary.mainAggregate.percentage}%, ${updatedSummary.mainAggregate.obtainedMarks}/${updatedSummary.mainAggregate.maximumMarks}).`
        );
      }

      const nextVerdict: DocumentAnalysis['readinessVerdict'] =
        updatedSummary.requiresUserConfirmation
          ? 'Needs Clarification'
          : analysis.readabilityStatus === 'Unreadable'
            ? 'Incomplete'
            : 'Ready';

      const now = new Date().toISOString();
      const confirmedAnalysis: DocumentAnalysis = {
        ...analysis,
        id: makeId('ana'),
        extractedFields: updatedFields,
        marksheetSummary: updatedSummary,
        profileMismatches: nextProfileMismatches,
        manualVerificationItems: updatedSummary.requiresUserConfirmation
          ? updatedSummary.confirmationReasons
          : (analysis.manualVerificationItems || []).filter(
              (item) => !analysis.marksheetSummary?.confirmationReasons.includes(item)
            ),
        readinessVerdict: nextVerdict,
        createdAt: now,
      };

      const needsAttention =
        updatedSummary.requiresUserConfirmation ||
        nextProfileMismatches.length > 0 ||
        Boolean(analysis.expiryWarning?.trim());
      const nextProcStatus: DocumentProcessingStatus = needsAttention ? 'Needs Review' : 'Completed';
      const nextVerStatus: DocumentRecord['verificationStatus'] = needsAttention
        ? 'Needs Attention'
        : 'Analyzed';

      await saveDocumentAnalysis(confirmedAnalysis);
      await updateDocumentFields(docItem.id, {
        processingStatus: nextProcStatus,
        verificationStatus: nextVerStatus,
        lastAnalyzedAt: now,
        updatedAt: now,
      });

      setAnalyses((prev) => [confirmedAnalysis, ...prev]);
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === docItem.id
            ? {
                ...d,
                processingStatus: nextProcStatus,
                verificationStatus: nextVerStatus,
                lastAnalyzedAt: now,
                updatedAt: now,
              }
            : d
        )
      );
      setEditingSubjectDocId(null);
      setStatusNote(
        updatedSummary.mainAggregate
          ? `Confirmed "${docItem.fileName}" subject selection: ${updatedSummary.mainAggregate.obtainedMarks}/${updatedSummary.mainAggregate.maximumMarks} (${updatedSummary.mainAggregate.percentage}%).`
          : `Saved updated subject selection for "${docItem.fileName}".`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save confirmed subject calculation.');
    } finally {
      setConfirmingDocId(null);
    }
  };

  const handleSyncMarksToProfile = async (
    docItem: DocumentRecord,
    percentage: number
  ) => {
    if (!user || !profile) return;
    setSyncingProfileDocId(docItem.id);
    setError(null);
    try {
      await saveProfile({
        ...profile,
        uid: user.uid,
        previousMarksPercent: percentage,
        updatedAt: new Date().toISOString(),
      });
      await refreshProfile();
      setStatusNote(
        `Synced ${percentage}% from "${docItem.fileName}" to your student profile for Eligibility Checker & AI Companion.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync marks percentage to profile.');
    } finally {
      setSyncingProfileDocId(null);
    }
  };

  const handleDropFiles = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (!storageStatus.uploadAvailable) return;
    const dropped = Array.from(e.dataTransfer.files ?? []);
    if (dropped.length > 0) {
      setSelectedFiles(dropped);
    }
  };

  return (
    <AppShell
      title="Document Intelligence"
      breadcrumb="Workspace / OCR, Marksheet Extraction & Vault"
    >
      <PageTransition>
        <div className="space-y-6">
          {/* Hidden file input for Replace action */}
          <input
            ref={replaceInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
            className="hidden"
            onChange={handleReplaceFileSelected}
          />

          {/* KPI Overview Strip */}
          <StaggerGrid className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StaggerItem>
              <div className="surface-card p-5">
                <p className="text-xs font-medium text-slate-400">Uploaded Documents</p>
                <p className="text-2xl font-bold text-white font-mono-num mt-1.5">
                  <AnimatedCounter value={metrics.total} />
                </p>
              </div>
            </StaggerItem>
            <StaggerItem>
              <div className="surface-card p-5">
                <p className="text-xs font-medium text-slate-400">Successfully Analyzed</p>
                <p className="text-2xl font-bold text-emerald-300 font-mono-num mt-1.5">
                  <AnimatedCounter value={metrics.completed} />
                </p>
              </div>
            </StaggerItem>
            <StaggerItem>
              <div className="surface-card p-5">
                <p className="text-xs font-medium text-slate-400">Needs Review / Failed</p>
                <p className="text-2xl font-bold text-amber-300 font-mono-num mt-1.5">
                  <AnimatedCounter value={metrics.needsReview} />
                </p>
              </div>
            </StaggerItem>
            <StaggerItem>
              <div className="surface-card p-5">
                <p className="text-xs font-medium text-slate-400">Missing Required Docs</p>
                <p className="text-2xl font-bold text-rose-300 font-mono-num mt-1.5">
                  <AnimatedCounter value={metrics.missingRequired} />
                </p>
              </div>
            </StaggerItem>
          </StaggerGrid>

          {/* Upload & Multi-Stage Extraction Form */}
          <form onSubmit={handleUploadAndAnalyze} className="surface-card p-6 space-y-5">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-white font-display">
                Document Verification, Requirement Comparison &amp; Marksheet Rules
              </h2>
              <p className="text-xs text-slate-400">
                Compare your scholarship requirements below and review saved extraction reports. New file uploads support PDF, JPG, JPEG, and PNG scans (max 8 MB) when private storage is active.
              </p>
            </div>

            {storageStatus.checked && !storageStatus.uploadAvailable && (
              <div
                role="status"
                className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs sm:text-sm text-amber-200 flex items-start gap-3"
              >
                <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5 text-amber-400" />
                <div className="space-y-1">
                  <p className="font-semibold text-amber-100">
                    Document Upload Temporarily Unavailable (Public Beta)
                  </p>
                  <p className="text-xs text-amber-200/90 leading-relaxed">
                    {storageStatus.reason} Scholarship requirement comparison, Scholarship Discovery, Eligibility Checker, AI Companion, Readiness Score, TrustGuard link checking, and Application Tracker remain fully active.
                  </p>
                </div>
              </div>
            )}

            {error && (
              <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-sm text-rose-200 flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                <span>{error}</span>
              </div>
            )}

            {statusNote && (
              <div className="p-3.5 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-sm text-indigo-200">
                {statusNote}
              </div>
            )}

            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Document Category
                </label>
                <select
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                  disabled={!storageStatus.uploadAvailable}
                  className="input-midnight w-full px-3.5 py-2.5 text-sm disabled:opacity-50"
                >
                  {DOCUMENT_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Compare Against Scholarship
                </label>
                <select
                  value={selectedScholarshipId}
                  onChange={(e) => setSelectedScholarshipId(e.target.value)}
                  className="input-midnight w-full px-3.5 py-2.5 text-sm"
                >
                  {scholarships.length === 0 ? (
                    <option value="">No scholarships loaded</option>
                  ) : (
                    scholarships.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>

            {/* Interactive Dropzone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (storageStatus.uploadAvailable) setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDropFiles}
              aria-disabled={!storageStatus.uploadAvailable}
              className={`rounded-xl border border-dashed p-5 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                !storageStatus.uploadAvailable
                  ? 'border-slate-800 bg-[#070C1B]/40 opacity-60 cursor-not-allowed'
                  : dragActive
                    ? 'border-indigo-400 bg-indigo-500/10'
                    : 'border-slate-700 bg-[#070C1B]/70 hover:border-slate-600'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center shrink-0">
                  <UploadCloud className="w-5 h-5 text-indigo-300" />
                </div>
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-slate-100">
                    {storageStatus.uploadAvailable
                      ? 'Drag & drop scans here, or browse files'
                      : 'Document binary upload paused during public beta'}
                  </p>
                  <p className="text-xs text-slate-400">
                    Accepted formats: PDF, JPG, JPEG, PNG · Up to 8 MB per file
                  </p>
                </div>
              </div>

              <input
                ref={uploadInputRef}
                type="file"
                multiple
                disabled={!storageStatus.uploadAvailable}
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                onChange={(e) => setSelectedFiles(Array.from(e.target.files ?? []))}
                className="text-xs text-slate-300 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border file:border-slate-700 file:text-xs file:font-semibold file:bg-[#101933] file:text-slate-100 hover:file:bg-slate-800 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            {selectedFiles.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-400 font-mono-num">
                  Queued ({selectedFiles.length}):
                </span>
                {selectedFiles.map((f, idx) => (
                  <span
                    key={`${f.name}-${idx}`}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#070C1B] border border-slate-800 text-slate-200 font-mono-num"
                  >
                    <span>
                      {f.name} ({Math.round(f.size / 1024)} KB)
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedFiles((prev) => prev.filter((_, i) => i !== idx))
                      }
                      aria-label={`Remove ${f.name}`}
                      className="text-slate-400 hover:text-rose-300"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <button
              type="submit"
              disabled={!storageStatus.uploadAvailable || busy || selectedFiles.length === 0}
              className="btn-primary-gradient inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl disabled:opacity-50 whitespace-nowrap"
            >
              <UploadCloud className="w-4 h-4" />
              <span>
                {!storageStatus.checked
                  ? 'Checking Storage Availability...'
                  : !storageStatus.uploadAvailable
                    ? 'Document Upload Unavailable (Public Beta)'
                    : busy
                      ? 'Processing Pipeline Running...'
                      : `Upload & Analyze ${selectedFiles.length > 1 ? `${selectedFiles.length} Documents` : 'Document'}`}
              </span>
            </button>
          </form>

          {/* Scholarship Document Requirement Comparison Panel */}
          {scholarshipComparison && (
            <div className="surface-card p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
                <div>
                  <h2 className="text-base font-semibold text-white font-display">
                    Scholarship Requirement Comparison
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Checking actual published requirements for{' '}
                    <strong className="text-slate-200">{scholarshipComparison.scholarshipTitle}</strong>
                  </p>
                </div>
                {scholarshipComparison.hasPublishedRequirements && (
                  <div className="flex items-center gap-3 shrink-0">
                    <CircularProgressRing
                      percent={scholarshipComparison.readinessPercent}
                      size={56}
                      strokeWidth={5}
                      tone={
                        scholarshipComparison.readinessPercent >= 80
                          ? 'emerald'
                          : scholarshipComparison.readinessPercent >= 50
                            ? 'amber'
                            : 'indigo'
                      }
                    />
                    <div className="text-xs text-slate-400 font-mono-num space-y-0.5">
                      <p className="text-slate-200 font-semibold">Doc Readiness</p>
                      <p>
                        {scholarshipComparison.readyCount} ready ·{' '}
                        {scholarshipComparison.needsReviewCount} review ·{' '}
                        {scholarshipComparison.missingCount} missing
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {scholarshipComparison.limitationNotice && (
                <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2.5">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                  <span>{scholarshipComparison.limitationNotice}</span>
                </div>
              )}

              {scholarshipComparison.hasPublishedRequirements && (
                <div className="grid md:grid-cols-2 gap-3">
                  {scholarshipComparison.items.map((item) => (
                    <div
                      key={item.requiredDocument}
                      className="p-4 rounded-xl bg-[#070C1B]/75 border border-slate-800/90 space-y-1.5"
                    >
                      <div className="flex items-start justify-between gap-2 text-xs">
                        <span className="font-semibold text-slate-100">{item.requiredDocument}</span>
                        <span
                          className={`shrink-0 font-semibold ${
                            item.status === 'Ready'
                              ? 'text-emerald-300'
                              : item.status === 'Needs Review'
                                ? 'text-amber-300'
                                : item.status === 'Processing'
                                  ? 'text-indigo-300'
                                  : 'text-rose-300'
                          }`}
                        >
                          {item.status}
                        </span>
                      </div>
                      {item.matchedDocument && (
                        <p className="text-[11px] text-slate-400">
                          Matched upload:{' '}
                          <span className="font-medium text-slate-200">
                            {item.matchedDocument.fileName}
                          </span>
                        </p>
                      )}
                      {item.notes.map((n, idx) => (
                        <p key={idx} className="text-xs text-slate-400 leading-relaxed">
                          {n}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Uploaded Documents & Detailed Extraction Reports */}
          <div className="surface-card p-6 space-y-4">
            <h2 className="text-base font-semibold text-white font-display">
              Document Vault &amp; Extraction Reports ({documents.length})
            </h2>

            {documents.length === 0 ? (
              <p className="text-sm text-slate-400">
                No documents uploaded yet. Upload your Income Certificate, Marksheet, Caste, or Domicile certificate above to run real text extraction and verification.
              </p>
            ) : (
              <div className="space-y-4">
                {documents.map((docItem) => {
                  const analysis = latestAnalysisByDoc.get(docItem.id);
                  const isExpanded = expandedDocId === docItem.id;
                  const docBusy = activeDocIds.has(docItem.id);
                  const effectiveProcStatus: DocumentProcessingStatus =
                    docItem.processingStatus ??
                    (docItem.verificationStatus === 'Analyzed'
                      ? 'Completed'
                      : docItem.verificationStatus === 'Needs Attention'
                        ? 'Needs Review'
                        : 'Pending');

                  return (
                    <div
                      key={docItem.id}
                      className="p-5 rounded-2xl border border-slate-800 bg-[#070C1B]/70 space-y-4"
                    >
                      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center shrink-0 mt-0.5">
                            <FileText className="w-4 h-4 text-indigo-300" />
                          </div>
                          <div className="min-w-0 space-y-0.5">
                            <p className="text-sm font-semibold text-white truncate">
                              {docItem.fileName}
                            </p>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
                              <span className="font-medium text-slate-200">{docItem.documentType}</span>
                              <span aria-hidden="true">·</span>
                              <span className={getProcessingStatusClass(effectiveProcStatus)}>
                                {docBusy ? 'Processing...' : effectiveProcStatus}
                              </span>
                              {typeof docItem.pageCount === 'number' && docItem.pageCount > 0 && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono-num">{docItem.pageCount} page(s)</span>
                                </>
                              )}
                              {docItem.extractionMethod && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>{docItem.extractionMethod}</span>
                                </>
                              )}
                              {docItem.lastAnalyzedAt && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono-num">
                                    Analyzed {new Date(docItem.lastAnalyzedAt).toLocaleDateString('en-IN')}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => void handlePreview(docItem)}
                            disabled={previewLoadingId === docItem.id}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#101933] border border-slate-700/80 rounded-lg hover:bg-slate-800 whitespace-nowrap"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>{previewLoadingId === docItem.id ? 'Loading...' : 'Preview'}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setReplaceTargetDoc(docItem);
                              replaceInputRef.current?.click();
                            }}
                            disabled={docBusy || !storageStatus.uploadAvailable}
                            title={
                              storageStatus.uploadAvailable
                                ? 'Replace document file'
                                : 'File replacement unavailable during public beta'
                            }
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#101933] border border-slate-700/80 rounded-lg hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                          >
                            <Upload className="w-3.5 h-3.5" />
                            <span>Replace</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => void handleRetryAnalysis(docItem)}
                            disabled={docBusy}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-200 bg-indigo-500/15 border border-indigo-500/30 rounded-lg hover:bg-indigo-500/25 disabled:opacity-50 whitespace-nowrap"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${docBusy ? 'animate-spin' : ''}`} />
                            <span>
                              {effectiveProcStatus === 'Failed' ? 'Retry Failed Analysis' : 'Re-Analyze'}
                            </span>
                          </button>

                          {analysis && (
                            <button
                              type="button"
                              onClick={() => setExpandedDocId(isExpanded ? null : docItem.id)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-slate-800 border border-slate-700 rounded-lg hover:bg-slate-700 whitespace-nowrap"
                            >
                              <span>{isExpanded ? 'Hide Details' : 'Inspect Details'}</span>
                              {isExpanded ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => void handleDelete(docItem)}
                            aria-label="Delete document"
                            className="p-1.5 text-slate-500 hover:text-rose-400 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {docItem.errorDetails && (
                        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200 flex items-start gap-2">
                          <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                          <span>
                            <strong className="text-rose-100">Processing Error:</strong>{' '}
                            {docItem.errorDetails}
                          </span>
                        </div>
                      )}

                      <AnimatePresence>
                        {analysis && isExpanded && (
                          <motion.div
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.22 }}
                            className="pt-4 border-t border-slate-800/80 space-y-5"
                          >
                            {/* Analysis Overview Strip */}
                            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                              <div className="p-3.5 rounded-xl bg-[#0B1224] border border-slate-800">
                                <p className="text-slate-400">Detected Type &amp; Readability</p>
                                <p className="font-semibold text-slate-100 mt-1">
                                  {analysis.detectedType} · {analysis.readabilityStatus || 'Readable'}
                                </p>
                              </div>
                              <div className="p-3.5 rounded-xl bg-[#0B1224] border border-slate-800">
                                <p className="text-slate-400">Readiness &amp; Confidence</p>
                                <p className="font-semibold text-slate-100 mt-1">
                                  {analysis.readinessVerdict} · {analysis.overallConfidence || 'Medium'} Confidence
                                </p>
                              </div>
                              <div className="p-3.5 rounded-xl bg-[#0B1224] border border-slate-800">
                                <p className="text-slate-400">Issuing Authority</p>
                                <p className="font-semibold text-slate-100 mt-1">
                                  {analysis.issuingAuthority || 'Not Clearly Visible'}
                                </p>
                              </div>
                              <div className="p-3.5 rounded-xl bg-[#0B1224] border border-slate-800">
                                <p className="text-slate-400">Validity Observations</p>
                                <p className="font-semibold text-slate-100 mt-1">
                                  {analysis.validityNotes || 'Check portal cutoff dates'}
                                </p>
                              </div>
                            </div>

                            {analysis.expiryWarning && (
                              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2.5">
                                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                                <span>
                                  <strong className="text-amber-100">Date / Expiry Warning:</strong>{' '}
                                  {analysis.expiryWarning}
                                </span>
                              </div>
                            )}

                            {analysis.profileMismatches && analysis.profileMismatches.length > 0 && (
                              <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200 space-y-1.5">
                                <p className="font-semibold text-rose-100">
                                  Potential Profile Mismatches
                                </p>
                                <ul className="list-disc list-inside space-y-0.5">
                                  {analysis.profileMismatches.map((m, idx) => (
                                    <li key={idx}>{m}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Academic Marksheet Subject-Wise & Dual-Aggregate Breakdown */}
                            {analysis.marksheetSummary && (
                              <div className="bg-[#0B1224] border border-slate-800 rounded-xl p-5 space-y-4">
                                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-800/80 pb-3.5">
                                  <div>
                                    <h3 className="text-sm font-semibold text-white font-display">
                                      Academic Marksheet Breakdown &amp; Aggregate Summary
                                    </h3>
                                    <p className="text-xs text-slate-400 mt-0.5">
                                      <span>{analysis.marksheetSummary.boardOrUniversity}</span>
                                      <span aria-hidden="true"> · </span>
                                      <span>{analysis.marksheetSummary.examinationName}</span>
                                      <span aria-hidden="true"> · </span>
                                      <span
                                        className={
                                          analysis.marksheetSummary.requiresUserConfirmation
                                            ? 'text-amber-300 font-semibold'
                                            : 'text-emerald-300 font-semibold'
                                        }
                                      >
                                        {analysis.marksheetSummary.confirmationStatus}
                                      </span>
                                    </p>
                                  </div>

                                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        editingSubjectDocId === docItem.id
                                          ? setEditingSubjectDocId(null)
                                          : openSubjectConfirmationEditor(
                                              docItem.id,
                                              analysis.marksheetSummary!
                                            )
                                      }
                                      className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#101933] border border-slate-700/80 rounded-lg hover:bg-slate-800 whitespace-nowrap"
                                    >
                                      {editingSubjectDocId === docItem.id
                                        ? 'Cancel Editing'
                                        : analysis.marksheetSummary.requiresUserConfirmation
                                          ? 'Confirm Subject Rules'
                                          : 'Adjust Subject Roles'}
                                    </button>

                                    {analysis.marksheetSummary.mainAggregate &&
                                      !analysis.marksheetSummary.requiresUserConfirmation &&
                                      profile &&
                                      profile.previousMarksPercent !==
                                        analysis.marksheetSummary.mainAggregate.percentage && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            void handleSyncMarksToProfile(
                                              docItem,
                                              analysis.marksheetSummary!.mainAggregate!.percentage
                                            )
                                          }
                                          disabled={syncingProfileDocId === docItem.id}
                                          className="btn-primary-gradient px-3.5 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-50 whitespace-nowrap"
                                        >
                                          {syncingProfileDocId === docItem.id
                                            ? 'Syncing...'
                                            : `Sync ${analysis.marksheetSummary.mainAggregate.percentage}% to Profile`}
                                        </button>
                                      )}
                                  </div>
                                </div>

                                {/* Dual Aggregate Summary Tiles */}
                                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                                  <div className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800 space-y-1">
                                    <p className="text-slate-400 font-medium">
                                      {analysis.marksheetSummary.mainAggregate?.label ||
                                        'Main Aggregate'}
                                    </p>
                                    {analysis.marksheetSummary.mainAggregate ? (
                                      <>
                                        <p className="text-lg font-bold text-white font-mono-num">
                                          {analysis.marksheetSummary.mainAggregate.obtainedMarks} /{' '}
                                          {analysis.marksheetSummary.mainAggregate.maximumMarks} ·{' '}
                                          <span className="text-indigo-300">
                                            {analysis.marksheetSummary.mainAggregate.percentage}%
                                          </span>
                                        </p>
                                        <p className="text-[11px] text-slate-400">
                                          {analysis.marksheetSummary.mainAggregate.sourceType ===
                                          'ai-calculated'
                                            ? 'AI-Calculated (overall total not printed on sheet)'
                                            : 'Document-Extracted'}
                                        </p>
                                      </>
                                    ) : (
                                      <p className="text-sm font-semibold text-amber-300">
                                        Confirmation needed before calculating
                                      </p>
                                    )}
                                  </div>

                                  {analysis.marksheetSummary.aggregateIncludingAdditional && (
                                    <div className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800 space-y-1">
                                      <p className="text-slate-400 font-medium">
                                        {analysis.marksheetSummary.aggregateIncludingAdditional.label}
                                      </p>
                                      <p className="text-lg font-bold text-white font-mono-num">
                                        {
                                          analysis.marksheetSummary.aggregateIncludingAdditional
                                            .obtainedMarks
                                        }{' '}
                                        /{' '}
                                        {
                                          analysis.marksheetSummary.aggregateIncludingAdditional
                                            .maximumMarks
                                        }{' '}
                                        ·{' '}
                                        <span className="text-slate-200">
                                          {
                                            analysis.marksheetSummary.aggregateIncludingAdditional
                                              .percentage
                                          }
                                          %
                                        </span>
                                      </p>
                                      <p className="text-[11px] text-slate-400">
                                        {analysis.marksheetSummary.aggregateIncludingAdditional
                                          .sourceType === 'ai-calculated'
                                          ? 'AI-Calculated · Tracked separately from main aggregate'
                                          : 'Document-Extracted · Tracked separately'}
                                      </p>
                                    </div>
                                  )}

                                  <div className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800 space-y-1">
                                    <p className="text-slate-400 font-medium">
                                      Applicable Assessment Rule
                                    </p>
                                    <p className="text-xs font-semibold text-slate-100 leading-relaxed">
                                      {analysis.marksheetSummary.applicableRule}
                                    </p>
                                    <p className="text-[11px] text-slate-400">
                                      {analysis.marksheetSummary.hasPrintedOverallAggregate
                                        ? 'Overall aggregate printed on document'
                                        : 'Subject-wise marks only; aggregate is AI-Calculated'}
                                    </p>
                                  </div>
                                </div>

                                {/* Confirmation Request Alert */}
                                {analysis.marksheetSummary.requiresUserConfirmation && (
                                  <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 space-y-1.5">
                                    <p className="font-semibold text-amber-100 flex items-center gap-1.5">
                                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                                      <span>Confirmation Requested Before Finalizing Aggregate</span>
                                    </p>
                                    <ul className="list-disc list-inside space-y-0.5">
                                      {analysis.marksheetSummary.confirmationReasons.map((r, i) => (
                                        <li key={i}>{r}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}

                                {/* Interactive Subject Role Confirmation Editor */}
                                {editingSubjectDocId === docItem.id && subjectDrafts[docItem.id] && (
                                  <div className="p-4 rounded-xl bg-[#070C1B]/90 border border-indigo-500/30 space-y-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <p className="text-xs font-semibold text-white">
                                        Confirm Main vs Additional Subjects &amp; Maximum Marks
                                      </p>
                                      <button
                                        type="button"
                                        disabled={confirmingDocId === docItem.id}
                                        onClick={() =>
                                          void handleConfirmSubjectSelection(docItem, analysis)
                                        }
                                        className="btn-primary-gradient px-3.5 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-50 whitespace-nowrap"
                                      >
                                        {confirmingDocId === docItem.id
                                          ? 'Recalculating...'
                                          : 'Confirm & Recalculate Aggregate'}
                                      </button>
                                    </div>
                                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs">
                                      {subjectDrafts[docItem.id].map((row, idx) => (
                                        <div
                                          key={idx}
                                          className="p-3 rounded-lg bg-[#0B1224] border border-slate-800 space-y-2"
                                        >
                                          <p className="font-medium text-slate-100 truncate">
                                            {row.subjectName}
                                          </p>
                                          <div className="grid grid-cols-2 gap-2">
                                            <select
                                              value={row.subjectCategory}
                                              onChange={(e) => {
                                                const val = e.target.value as MarksheetSubjectRole;
                                                setSubjectDrafts((prev) => ({
                                                  ...prev,
                                                  [docItem.id]: prev[docItem.id].map((item, i) =>
                                                    i === idx
                                                      ? { ...item, subjectCategory: val }
                                                      : item
                                                  ),
                                                }));
                                              }}
                                              className="input-midnight px-2 py-1 text-xs"
                                            >
                                              <option value="main">Main</option>
                                              <option value="additional">Additional</option>
                                              <option value="excluded">Excluded</option>
                                            </select>
                                            <input
                                              type="number"
                                              min="1"
                                              placeholder="Max"
                                              value={row.maxMarks}
                                              onChange={(e) => {
                                                const val = e.target.value;
                                                setSubjectDrafts((prev) => ({
                                                  ...prev,
                                                  [docItem.id]: prev[docItem.id].map((item, i) =>
                                                    i === idx ? { ...item, maxMarks: val } : item
                                                  ),
                                                }));
                                              }}
                                              className="input-midnight px-2 py-1 text-xs font-mono-num"
                                            />
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* Subject-Wise Table */}
                                {analysis.marksheetSummary.subjects.length > 0 && (
                                  <div className="border border-slate-800 rounded-xl overflow-hidden">
                                    <div className="overflow-x-auto">
                                      <table className="w-full text-left text-xs">
                                        <thead className="bg-[#070C1B] border-b border-slate-800 text-slate-400">
                                          <tr>
                                            <th className="px-3.5 py-2.5 font-medium">Subject</th>
                                            <th className="px-3.5 py-2.5 font-medium">Category</th>
                                            <th className="px-3.5 py-2.5 font-medium text-right">Theory</th>
                                            <th className="px-3.5 py-2.5 font-medium text-right">
                                              Internal / Prac
                                            </th>
                                            <th className="px-3.5 py-2.5 font-medium text-right">
                                              Printed Total
                                            </th>
                                            <th className="px-3.5 py-2.5 font-medium text-right">
                                              Calculated Total
                                            </th>
                                            <th className="px-3.5 py-2.5 font-medium text-right">Max</th>
                                            <th className="px-3.5 py-2.5 font-medium">Source</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-800/70">
                                          {analysis.marksheetSummary.subjects.map((subj, idx) => (
                                            <tr key={idx} className="hover:bg-slate-800/30">
                                              <td className="px-3.5 py-2.5 text-slate-100">
                                                <div className="font-medium">
                                                  {subj.subjectCode ? `${subj.subjectCode} · ` : ''}
                                                  {subj.subjectName}
                                                </div>
                                                {subj.discrepancyNote && (
                                                  <p className="text-[11px] text-amber-300 mt-0.5">
                                                    {subj.discrepancyNote}
                                                  </p>
                                                )}
                                              </td>
                                              <td className="px-3.5 py-2.5">
                                                <span
                                                  className={
                                                    subj.subjectCategory === 'main'
                                                      ? 'text-emerald-300 font-semibold'
                                                      : subj.subjectCategory === 'additional'
                                                        ? 'text-indigo-300 font-medium'
                                                        : 'text-amber-300 font-semibold'
                                                  }
                                                >
                                                  {subj.subjectCategory === 'main'
                                                    ? 'Main'
                                                    : subj.subjectCategory === 'additional'
                                                      ? 'Additional'
                                                      : subj.subjectCategory === 'excluded'
                                                        ? 'Excluded'
                                                        : 'Uncertain'}
                                                </span>
                                              </td>
                                              <td className="px-3.5 py-2.5 text-right font-mono-num text-slate-300">
                                                {subj.theoryMarks ?? '—'}
                                              </td>
                                              <td className="px-3.5 py-2.5 text-right font-mono-num text-slate-300">
                                                {subj.internalOrPracticalMarks ?? '—'}
                                              </td>
                                              <td className="px-3.5 py-2.5 text-right font-mono-num text-slate-300">
                                                {subj.printedTotalMarks ?? '—'}
                                              </td>
                                              <td className="px-3.5 py-2.5 text-right font-mono-num font-semibold text-white">
                                                {subj.calculatedTotalMarks ?? '—'}
                                              </td>
                                              <td className="px-3.5 py-2.5 text-right font-mono-num text-slate-400">
                                                {subj.maxMarks ?? '—'}
                                              </td>
                                              <td className="px-3.5 py-2.5 text-slate-400">
                                                {subj.totalSource === 'document-extracted'
                                                  ? 'Document-Extracted'
                                                  : 'AI-Calculated'}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )}

                                {analysis.marksheetSummary.calculationNotes.length > 0 && (
                                  <div className="text-[11px] text-slate-400 space-y-0.5">
                                    {analysis.marksheetSummary.calculationNotes.map((note, i) => (
                                      <p key={i}>· {note}</p>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Structured Extracted Fields Table */}
                            {analysis.extractedFields && analysis.extractedFields.length > 0 && (
                              <div className="bg-[#0B1224] border border-slate-800 rounded-xl overflow-hidden">
                                <div className="px-4 py-3 bg-[#070C1B] border-b border-slate-800 text-xs font-semibold text-slate-200">
                                  Extracted Structured Fields (Sensitive IDs Masked)
                                </div>
                                <div className="overflow-x-auto">
                                  <table className="w-full text-left text-xs">
                                    <thead className="border-b border-slate-800 text-slate-400">
                                      <tr>
                                        <th className="px-4 py-2.5 font-medium">Field</th>
                                        <th className="px-4 py-2.5 font-medium">Extracted Value</th>
                                        <th className="px-4 py-2.5 font-medium">Status</th>
                                        <th className="px-4 py-2.5 font-medium">Confidence</th>
                                        <th className="px-4 py-2.5 font-medium">Page</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800/70">
                                      {analysis.extractedFields.map((f, idx) => (
                                        <tr key={idx} className="hover:bg-slate-800/30">
                                          <td className="px-4 py-2.5 font-medium text-slate-200">
                                            {f.fieldName}
                                          </td>
                                          <td className="px-4 py-2.5 text-slate-300 font-mono-num">
                                            {f.value || '—'}
                                          </td>
                                          <td className="px-4 py-2.5">
                                            <span
                                              className={
                                                f.status === 'Extracted'
                                                  ? 'text-emerald-300 font-medium'
                                                  : f.status === 'Unreadable'
                                                    ? 'text-rose-300 font-medium'
                                                    : 'text-amber-300 font-medium'
                                              }
                                            >
                                              {f.status}
                                            </span>
                                          </td>
                                          <td className="px-4 py-2.5 text-slate-400">{f.confidence}</td>
                                          <td className="px-4 py-2.5 font-mono-num text-slate-500">
                                            {f.pageNumber ? `p.${f.pageNumber}` : 'p.1'}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}

                            {/* Missing, Unreadable, Manual Verification & Recommendations */}
                            <div className="grid md:grid-cols-2 gap-4 text-xs">
                              <div className="bg-[#0B1224] border border-slate-800 rounded-xl p-4 space-y-3">
                                {analysis.missingFields && analysis.missingFields.length > 0 && (
                                  <div>
                                    <p className="font-semibold text-amber-300 flex items-center gap-1.5">
                                      <HelpCircle className="w-3.5 h-3.5" />
                                      <span>Absent / Missing Fields</span>
                                    </p>
                                    <ul className="list-disc list-inside text-slate-300 mt-1 space-y-0.5">
                                      {analysis.missingFields.map((item, i) => (
                                        <li key={i}>{item}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {analysis.unreadableFields && analysis.unreadableFields.length > 0 && (
                                  <div>
                                    <p className="font-semibold text-rose-300">Unreadable Fields</p>
                                    <ul className="list-disc list-inside text-slate-300 mt-1 space-y-0.5">
                                      {analysis.unreadableFields.map((item, i) => (
                                        <li key={i}>{item}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {analysis.manualVerificationItems &&
                                  analysis.manualVerificationItems.length > 0 && (
                                    <div>
                                      <p className="font-semibold text-slate-100">
                                        Requires Manual Verification
                                      </p>
                                      <ul className="list-disc list-inside text-slate-300 mt-1 space-y-0.5">
                                        {analysis.manualVerificationItems.map((item, i) => (
                                          <li key={i}>{item}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                              </div>

                              <div className="bg-[#0B1224] border border-slate-800 rounded-xl p-4 space-y-3">
                                {analysis.issuesFound && analysis.issuesFound.length > 0 && (
                                  <div>
                                    <p className="font-semibold text-slate-100">Detected Issues</p>
                                    <ul className="list-disc list-inside text-slate-300 mt-1 space-y-0.5">
                                      {analysis.issuesFound.map((iss, idx) => (
                                        <li key={idx}>{iss}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {analysis.recommendations && analysis.recommendations.length > 0 && (
                                  <div>
                                    <p className="font-semibold text-emerald-300 flex items-center gap-1.5">
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                      <span>Recommended Next Steps</span>
                                    </p>
                                    <ul className="list-disc list-inside text-slate-300 mt-1 space-y-0.5">
                                      {analysis.recommendations.map((rec, idx) => (
                                        <li key={idx}>{rec}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </div>
                            </div>

                            {analysis.rawTextPreview && (
                              <details className="bg-[#0B1224] border border-slate-800 rounded-xl p-4 text-xs">
                                <summary className="cursor-pointer font-medium text-slate-200 hover:text-white">
                                  View Extracted Text Layer / OCR Preview
                                </summary>
                                <pre className="mt-3 whitespace-pre-wrap text-[11px] text-slate-400 font-mono max-h-48 overflow-y-auto">
                                  {analysis.rawTextPreview}
                                </pre>
                              </details>
                            )}

                            {/* Document Q&A Grounded in Stored Analysis */}
                            <div className="bg-[#0B1224] border border-slate-800 rounded-xl p-4 space-y-3">
                              <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                                <MessageSquare className="w-3.5 h-3.5 text-indigo-400" />
                                <span>Ask Questions About This Document</span>
                              </div>

                              {(qaHistory[docItem.id] || []).length > 0 && (
                                <div className="space-y-2 max-h-60 overflow-y-auto">
                                  {(qaHistory[docItem.id] || []).map((entry, idx) => (
                                    <div
                                      key={idx}
                                      className="p-3 rounded-xl bg-[#070C1B] border border-slate-800 text-xs space-y-1"
                                    >
                                      <p className="font-semibold text-indigo-200">
                                        Q: {entry.question}
                                      </p>
                                      <p className="text-slate-300 whitespace-pre-line leading-relaxed">
                                        {entry.answer}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              )}

                              <form
                                onSubmit={(e) => void handleAskDocumentQuestion(e, docItem, analysis)}
                                className="flex gap-2"
                              >
                                <input
                                  type="text"
                                  value={questionDrafts[docItem.id] || ''}
                                  onChange={(e) =>
                                    setQuestionDrafts((prev) => ({
                                      ...prev,
                                      [docItem.id]: e.target.value,
                                    }))
                                  }
                                  placeholder="e.g. Does the extracted income qualify for the selected scholarship?"
                                  className="input-midnight flex-1 px-3 py-2 text-xs"
                                />
                                <button
                                  type="submit"
                                  disabled={
                                    qaBusyDocId === docItem.id ||
                                    !(questionDrafts[docItem.id] || '').trim()
                                  }
                                  className="btn-primary-gradient px-3.5 py-2 text-xs font-semibold rounded-lg disabled:opacity-50 whitespace-nowrap"
                                >
                                  {qaBusyDocId === docItem.id ? 'Checking...' : 'Ask AI'}
                                </button>
                              </form>
                            </div>

                            <p className="text-[11px] text-slate-500">
                              {analysis.disclaimer ||
                                'AI extraction assists scholarship preparation and does not confirm official government authenticity.'}
                            </p>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </PageTransition>

      {/* Private Document Inline Preview Modal */}
      {previewState && (
        <div className="fixed inset-0 z-50 bg-[#02050D]/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="surface-elevated max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-white truncate">
                Private Preview: {previewState.fileName}
              </p>
              <button
                type="button"
                onClick={() => setPreviewState(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close preview"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 bg-[#070C1B] p-4 overflow-auto flex items-center justify-center min-h-[420px]">
              {previewState.mimeType === 'application/pdf' ? (
                <iframe
                  title={previewState.fileName}
                  src={previewState.objectUrl}
                  className="w-full h-[70vh] rounded-lg border border-slate-800 bg-white"
                />
              ) : (
                <img
                  src={previewState.objectUrl}
                  alt={previewState.fileName}
                  className="max-w-full max-h-[70vh] object-contain rounded-lg border border-slate-800 bg-[#0B1224]"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
