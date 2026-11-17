import { compareDocumentsAgainstScholarship } from './documentComparison.ts';
import {
  evaluateDeterministicEligibility,
  isScholarshipSourceVerified,
} from './eligibilityEngine.ts';
import type {
  ApplicationRecord,
  DocumentAnalysis,
  DocumentExtractionConfidence,
  DocumentRecord,
  ExtractedDocumentField,
  SavedScholarship,
  Scholarship,
  StudentProfile,
  TrustGuardAffectedDocument,
  TrustGuardChangeSummary,
  TrustGuardDocumentAssessment,
  TrustGuardDocumentResult,
  TrustGuardEvidenceValue,
  TrustGuardFinding,
  TrustGuardFindingCategory,
  TrustGuardReviewStatus,
  TrustGuardRiskSeverity,
  TrustGuardSeverityCounts,
  TrustGuardVerificationStatus,
} from '../types/database.ts';

export const TRUSTGUARD_ALGORITHM_VERSION = 'grantly-trustguard-v1.0.0';

export const TRUSTGUARD_LIMITATION_NOTICE =
  'TrustGuard performs deterministic document-to-profile, cross-document, and scholarship rule consistency checks using stored extractions. No external government verification API (UIDAI, DigiLocker, e-District, or Education Board portal) is connected; TrustGuard cannot certify legal authenticity or detect document forgery.';

export const TRUSTGUARD_DISCLAIMER =
  'A flagged mismatch or manual review item highlights an apparent discrepancy or unreadable field for student verification prior to scholarship portal submission. It is not evidence of fraud.';

export const TRUSTGUARD_RULE_CONFIG = {
  version: TRUSTGUARD_ALGORITHM_VERSION,
  marksTolerancePercent: 1.0,
  incomeAbsoluteToleranceInr: 5000,
  incomeRelativeToleranceRatio: 0.05,
  incomeCertificateMaxAgeMonths: 12,
  severityWeights: {
    Critical: 5,
    High: 4,
    Medium: 3,
    Low: 2,
    Informational: 1,
  },
} as const;

type DocRole =
  | 'identity'
  | 'academic'
  | 'income'
  | 'caste'
  | 'domicile'
  | 'bonafide'
  | 'admission'
  | 'fee'
  | 'bank'
  | 'disability'
  | 'other';

function classifyDocRole(docType: string, detectedType?: string): DocRole {
  const combined = `${docType} ${detectedType ?? ''}`.toLowerCase();
  if (combined.includes('income')) return 'income';
  if (combined.includes('marksheet') || combined.includes('transcript') || combined.includes('grade card')) {
    return 'academic';
  }
  if (combined.includes('caste') || combined.includes('category') || combined.includes('ews') || combined.includes('minority')) {
    return 'caste';
  }
  if (combined.includes('domicile') || combined.includes('residence') || combined.includes('nativity')) {
    return 'domicile';
  }
  if (combined.includes('aadhaar') || combined.includes('identity') || combined.includes('pan ') || combined.includes('passport')) {
    return 'identity';
  }
  if (combined.includes('bonafide')) return 'bonafide';
  if (combined.includes('admission')) return 'admission';
  if (combined.includes('fee')) return 'fee';
  if (combined.includes('bank') || combined.includes('passbook')) return 'bank';
  if (combined.includes('disability') || combined.includes('udid') || combined.includes('pwd')) {
    return 'disability';
  }
  return 'other';
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(mr|ms|mrs|shri|kumari|smt|dr)\b\.?/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compareNames(a: string, b: string): 'match' | 'partial_or_initial' | 'mismatch' {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 'partial_or_initial';
  if (na === nb) return 'match';

  const tokensA = na.split(' ').filter(Boolean);
  const tokensB = nb.split(' ').filter(Boolean);
  const overlap = tokensA.filter((t) => tokensB.includes(t));
  const minLen = Math.min(tokensA.length, tokensB.length);

  if (minLen > 0 && overlap.length === minLen) {
    return 'partial_or_initial';
  }
  // Check single-letter middle initial equivalence (e.g., "Ananya R Sharma" vs "Ananya Sharma")
  if (overlap.length >= 2 || (tokensA.length === 2 && tokensB.length === 2 && overlap.length >= 1 && (tokensA.some((t) => t.length === 1) || tokensB.some((t) => t.length === 1)))) {
    return 'partial_or_initial';
  }
  return 'mismatch';
}

const MONTH_MAP: Record<string, string> = {
  jan: '01',
  january: '01',
  feb: '02',
  february: '02',
  mar: '03',
  march: '03',
  apr: '04',
  april: '04',
  may: '05',
  jun: '06',
  june: '06',
  jul: '07',
  july: '07',
  aug: '08',
  august: '08',
  sep: '09',
  sept: '09',
  september: '09',
  oct: '10',
  october: '10',
  nov: '11',
  november: '11',
  dec: '12',
  december: '12',
};

export function normalizeDateIso(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // YYYY-MM-DD
  const isoMatch = s.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    const mNum = Number(m);
    const dNum = Number(d);
    if (mNum >= 1 && mNum <= 12 && dNum >= 1 && dNum <= 31) {
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }

  // DD Mon YYYY (e.g., 14 Aug 2006)
  const monMatch = s.toLowerCase().match(/\b(\d{1,2})\s+([a-z]{3,9}),?\s+(\d{4})\b/);
  if (monMatch) {
    const [, d, mon, y] = monMatch;
    const mm = MONTH_MAP[mon];
    if (mm) {
      return `${y}-${mm}-${d.padStart(2, '0')}`;
    }
  }

  return null;
}

function parseNumericInr(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').replace(/rs\.?|inr|₹/gi, ' ');
  const lakhMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:lakh|lac|lacs)/i);
  if (lakhMatch) {
    return Math.round(Number(lakhMatch[1]) * 100000);
  }
  const numMatch = cleaned.match(/\d+(?:\.\d+)?/);
  if (!numMatch) return null;
  const val = Number(numMatch[0]);
  return Number.isFinite(val) ? Math.round(val) : null;
}

function normalizeStateName(raw: string): string {
  const lower = raw.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (lower.includes('delhi')) return 'delhi';
  if (lower.includes('jammu') && lower.includes('kashmir')) return 'jammu and kashmir';
  if (lower.includes('odisha') || lower.includes('orissa')) return 'odisha';
  if (lower.includes('uttaranchal') || lower.includes('uttarakhand')) return 'uttarakhand';
  if (lower.includes('pondicherry') || lower.includes('puducherry')) return 'puducherry';
  return lower;
}

function normalizeCategoryToken(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (/\bsc\b|scheduled\s*caste/.test(lower)) return 'SC';
  if (/\bst\b|scheduled\s*tribe/.test(lower)) return 'ST';
  if (/\bews\b|economically\s*weaker/.test(lower)) return 'EWS';
  if (/\bobc[\s-]*ncl\b|non[\s-]*creamy/.test(lower)) return 'OBC-NCL';
  if (/\bobc\b|other\s*backward/.test(lower)) return 'OBC';
  if (/\bminority\b|muslim|christian|sikh|buddhist|jain|parsi/.test(lower)) return 'Minority';
  if (/\bgeneral\b|\bunreserved\b|\bur\b/.test(lower)) return 'General';
  return null;
}

function findExtractedField(
  fields: ExtractedDocumentField[] | undefined,
  predicate: (lowerName: string) => boolean
): ExtractedDocumentField | undefined {
  if (!fields) return undefined;
  return fields.find(
    (f) => f.status !== 'Absent' && f.value?.trim() && predicate(f.fieldName.toLowerCase())
  );
}

function isLowConfidenceContext(
  fieldConf: DocumentExtractionConfidence | undefined,
  docConf: DocumentExtractionConfidence | undefined,
  readability: DocumentAnalysis['readabilityStatus']
): boolean {
  return (
    fieldConf === 'Low' ||
    docConf === 'Low' ||
    readability === 'Unreadable'
  );
}

export function computeTrustGuardDataFingerprint(params: {
  profile: StudentProfile | null;
  documents: DocumentRecord[];
  documentAnalyses: DocumentAnalysis[];
  scholarships: Scholarship[];
  savedScholarships: SavedScholarship[];
  applications: ApplicationRecord[];
}): string {
  const { profile, documents, documentAnalyses, scholarships, savedScholarships, applications } = params;
  const parts = [
    TRUSTGUARD_ALGORITHM_VERSION,
    `p:${profile?.fullName ?? ''}:${profile?.dateOfBirth ?? ''}:${profile?.state ?? ''}:${profile?.district ?? ''}:${profile?.category ?? ''}:${profile?.familyAnnualIncomeInr ?? 'x'}:${profile?.previousMarksPercent ?? 'x'}:${profile?.courseSpecialization ?? ''}:${profile?.institutionName ?? ''}:${profile?.updatedAt ?? ''}`,
    `d:${documents.map((d) => `${d.id}:${d.documentType}:${d.fileName}:${d.processingStatus ?? d.verificationStatus}:${d.updatedAt}`).sort().join(',')}`,
    `da:${documentAnalyses.map((a) => `${a.id}:${a.documentId}:${a.readinessVerdict}:${a.overallConfidence ?? ''}:${a.readabilityStatus ?? ''}:${a.marksheetSummary?.confirmationStatus ?? ''}:${a.createdAt}`).sort().join(',')}`,
    `sv:${savedScholarships.map((s) => s.scholarshipId).sort().join(',')}`,
    `ap:${applications.map((a) => `${a.scholarshipId}:${a.status}`).sort().join(',')}`,
    `sc:${scholarships.length}:${scholarships.map((s) => `${s.id}:${s.incomeLimitInr ?? 'x'}:${s.minMarksPercent ?? 'x'}:${s.verificationStatus}`).sort().join(',')}`,
  ];
  return `tgfp-${stableHash(parts.join('|'))}`;
}

interface FindingBuilderInput {
  keySeed: string;
  category: TrustGuardFindingCategory;
  severity: TrustGuardRiskSeverity;
  title: string;
  description: string;
  affectedDocuments: TrustGuardAffectedDocument[];
  conflictingValues: TrustGuardEvidenceValue[];
  evidenceSource: string;
  extractionConfidence: 'High' | 'Medium' | 'Low' | 'N/A';
  recommendedAction: string;
  relatedScholarshipIds?: string[];
  relatedScholarshipTitles?: string[];
}

export function evaluateTrustGuardVerification(params: {
  userId: string;
  profile: StudentProfile | null;
  documents: DocumentRecord[];
  documentAnalyses: DocumentAnalysis[];
  scholarships: Scholarship[];
  savedScholarships?: SavedScholarship[];
  applications?: ApplicationRecord[];
  previousAssessment?: TrustGuardDocumentAssessment | null;
  referenceDate?: Date;
}): Omit<TrustGuardDocumentAssessment, 'id' | 'aiSummary' | 'createdAt' | 'updatedAt'> {
  const {
    userId,
    profile,
    documents,
    documentAnalyses,
    scholarships,
    savedScholarships = [],
    applications = [],
    previousAssessment = null,
    referenceDate = new Date(),
  } = params;

  const dataFingerprint = computeTrustGuardDataFingerprint({
    profile,
    documents,
    documentAnalyses,
    scholarships,
    savedScholarships,
    applications,
  });

  // Latest analysis per document
  const latestAnalysisByDoc = new Map<string, DocumentAnalysis>();
  for (const ana of documentAnalyses) {
    const existing = latestAnalysisByDoc.get(ana.documentId);
    if (!existing || ana.createdAt > existing.createdAt) {
      latestAnalysisByDoc.set(ana.documentId, ana);
    }
  }

  // Relevant scholarships for impact linking
  const activeScholarships = scholarships.filter((s) => s.verificationStatus !== 'Archived');
  const trackedSet = new Set(applications.map((a) => a.scholarshipId));
  const savedSet = new Set(savedScholarships.map((s) => s.scholarshipId));
  const evaluatedSchemes = activeScholarships.map((s) => ({
    scholarship: s,
    det: evaluateDeterministicEligibility(profile, s, referenceDate),
    docComp: compareDocumentsAgainstScholarship(s, documents, documentAnalyses, profile),
  }));

  const relevantSchemes = evaluatedSchemes.filter(
    (item) =>
      trackedSet.has(item.scholarship.id) ||
      savedSet.has(item.scholarship.id) ||
      item.det.overallStatus === 'Eligible' ||
      item.det.overallStatus === 'Potentially Eligible'
  );

  // Track previous review status/notes cleanly (only preserve if evidenceFingerprint unchanged)
  const prevFindingsById = new Map<string, TrustGuardFinding>();
  if (previousAssessment) {
    for (const f of previousAssessment.findings) {
      prevFindingsById.set(f.findingId, f);
    }
  }

  const findingsMap = new Map<string, TrustGuardFinding>();
  const docCheckedFields = new Map<string, Set<string>>();
  documents.forEach((d) => docCheckedFields.set(d.id, new Set<string>()));

  const addFinding = (input: FindingBuilderInput) => {
    const findingId = `tgf-${stableHash(input.keySeed)}`;
    const evidenceFingerprint = stableHash(
      JSON.stringify({
        category: input.category,
        severity: input.severity,
        conflictingValues: input.conflictingValues,
        affectedIds: input.affectedDocuments.map((d) => d.documentId).sort(),
      })
    );

    const prev = prevFindingsById.get(findingId);
    const sameEvidence = prev && prev.evidenceFingerprint === evidenceFingerprint;
    const reviewStatus: TrustGuardReviewStatus = sameEvidence ? prev.reviewStatus : 'Unreviewed';
    const studentNote = sameEvidence ? prev.studentNote : undefined;
    const reviewedAt = sameEvidence ? prev.reviewedAt : undefined;
    const changeState: TrustGuardFinding['changeState'] = previousAssessment
      ? prev
        ? 'Unchanged'
        : 'New'
      : undefined;

    findingsMap.set(findingId, {
      findingId,
      evidenceFingerprint,
      category: input.category,
      severity: input.severity,
      title: input.title,
      description: input.description,
      affectedDocuments: input.affectedDocuments,
      conflictingValues: input.conflictingValues,
      evidenceSource: input.evidenceSource,
      extractionConfidence: input.extractionConfidence,
      recommendedAction: input.recommendedAction,
      ...(input.relatedScholarshipIds && input.relatedScholarshipIds.length > 0
        ? { relatedScholarshipIds: Array.from(new Set(input.relatedScholarshipIds)) }
        : {}),
      ...(input.relatedScholarshipTitles && input.relatedScholarshipTitles.length > 0
        ? { relatedScholarshipTitles: Array.from(new Set(input.relatedScholarshipTitles)) }
        : {}),
      reviewStatus,
      ...(studentNote ? { studentNote } : {}),
      ...(reviewedAt ? { reviewedAt } : {}),
      ...(changeState ? { changeState } : {}),
    });
  };

  // Empty documents check
  if (documents.length === 0) {
    return {
      userId,
      analysisVersion: TRUSTGUARD_ALGORITHM_VERSION,
      dataFingerprint,
      overallVerificationStatus: 'Not Analyzed',
      documentsTotalCount: 0,
      documentsAnalyzedCount: 0,
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
      documentResults: [],
      findings: [],
      correctiveActions: [
        'Upload your scholarship documents (Aadhaar, Income Certificate, Caste/Domicile Certificate, Academic Marksheet) in Document Intelligence to run TrustGuard consistency checks.',
      ],
      limitationNotice: TRUSTGUARD_LIMITATION_NOTICE,
      disclaimer: TRUSTGUARD_DISCLAIMER,
    };
  }

  let documentsAnalyzedCount = 0;
  let comparisonPerformedCount = 0;

  // Cross-doc accumulators (for cross-document checks when profile lacks or two docs disagree)
  const parentNamesByDoc: Array<{ doc: DocumentRecord; value: string; conf: DocumentExtractionConfidence }> = [];
  const dobByDoc: Array<{ doc: DocumentRecord; iso: string; raw: string; conf: DocumentExtractionConfidence }> = [];
  const domicileStatesByDoc: Array<{ doc: DocumentRecord; stateNorm: string; raw: string; conf: DocumentExtractionConfidence }> = [];
  const rollNumsByDoc: Array<{ doc: DocumentRecord; roll: string; level: string }> = [];

  // Duplicate upload detection
  const seenDocsByKey = new Map<string, DocumentRecord[]>();

  for (const doc of documents) {
    const analysis = latestAnalysisByDoc.get(doc.id);
    const role = classifyDocRole(doc.documentType, analysis?.detectedType);
    const affected: TrustGuardAffectedDocument[] = [
      { documentId: doc.id, fileName: doc.fileName, documentType: doc.documentType },
    ];
    const checked = docCheckedFields.get(doc.id)!;

    // Track duplicates by normalized category + normalized filename
    const normFileBase = doc.fileName
      .toLowerCase()
      .replace(/\(\d+\)/g, '')
      .replace(/copy/g, '')
      .replace(/[^a-z0-9.]/g, '');
    const dupKey = `${role}:${normFileBase}`;
    const dupList = seenDocsByKey.get(dupKey) ?? [];
    dupList.push(doc);
    seenDocsByKey.set(dupKey, dupList);

    // E0. Processing / Completeness status checks
    if (doc.processingStatus === 'Pending' || doc.processingStatus === 'Processing') {
      addFinding({
        keySeed: `processing:${doc.id}`,
        category: 'Document Completeness',
        severity: 'Informational',
        title: `Analysis in progress for ${doc.fileName}`,
        description: `Document "${doc.fileName}" (${doc.documentType}) is currently queued or processing.`,
        affectedDocuments: affected,
        conflictingValues: [
          { sourceLabel: doc.fileName, fieldName: 'Processing Status', value: doc.processingStatus },
        ],
        evidenceSource: 'Document Pipeline Status',
        extractionConfidence: 'N/A',
        recommendedAction: 'Wait for extraction to finish or trigger analysis in Document Intelligence.',
      });
      continue;
    }

    if (doc.processingStatus === 'Failed') {
      addFinding({
        keySeed: `failed:${doc.id}`,
        category: 'Document Completeness',
        severity: 'High',
        title: `Unable to extract data from ${doc.fileName}`,
        description:
          doc.errorDetails ||
          `Document Intelligence could not complete extraction for ${doc.fileName}. Consistency verification cannot be performed.`,
        affectedDocuments: affected,
        conflictingValues: [
          {
            sourceLabel: doc.fileName,
            fieldName: 'Processing Status',
            value: `Failed${doc.errorDetails ? ` (${doc.errorDetails})` : ''}`,
          },
        ],
        evidenceSource: 'Document Pipeline Status',
        extractionConfidence: 'Low',
        recommendedAction: 'Re-upload a clear, non-corrupted PDF/JPG/PNG copy in Document Intelligence.',
      });
      continue;
    }

    if (!analysis) {
      addFinding({
        keySeed: `unanalyzed:${doc.id}`,
        category: 'Document Completeness',
        severity: 'Medium',
        title: `Document not yet analyzed: ${doc.fileName}`,
        description: `No structured extraction record exists for "${doc.fileName}" (${doc.documentType}) yet.`,
        affectedDocuments: affected,
        conflictingValues: [
          { sourceLabel: doc.fileName, fieldName: 'Analysis Record', value: 'Not Analyzed' },
        ],
        evidenceSource: 'Document Analysis Repository',
        extractionConfidence: 'N/A',
        recommendedAction: 'Open Document Intelligence and run AI extraction on this file.',
      });
      continue;
    }

    documentsAnalyzedCount += 1;
    const fields = analysis.extractedFields ?? [];
    const docConf = analysis.overallConfidence ?? 'Medium';
    const readability = analysis.readabilityStatus ?? 'Readable';

    // E1. Unreadable / Low-Confidence OCR / Partially Readable
    if (readability === 'Unreadable') {
      addFinding({
        keySeed: `unreadable:${doc.id}`,
        category: 'Document Completeness',
        severity: 'High',
        title: `Unreadable scan detected: ${doc.fileName}`,
        description: `Extraction marked "${doc.fileName}" as Unreadable (${docConf} confidence). Reliable field comparison is not possible.`,
        affectedDocuments: affected,
        conflictingValues: [
          { sourceLabel: doc.fileName, fieldName: 'Readability', value: readability },
          { sourceLabel: doc.fileName, fieldName: 'Overall Confidence', value: docConf },
        ],
        evidenceSource: 'Document Intelligence Readability Check',
        extractionConfidence: docConf,
        recommendedAction: 'Upload a sharp, well-lit, uncropped scan or official digital PDF (e.g., from DigiLocker).',
      });
    } else if (readability === 'Partially Readable' || docConf === 'Low') {
      addFinding({
        keySeed: `lowconf:${doc.id}`,
        category: 'Document Completeness',
        severity: 'Medium',
        title: `Low-confidence or partial extraction: ${doc.fileName}`,
        description: `Some text in "${doc.fileName}" had ${docConf} confidence or Partial readability. Manual verification is recommended rather than relying on automated values.`,
        affectedDocuments: affected,
        conflictingValues: [
          { sourceLabel: doc.fileName, fieldName: 'Readability', value: readability },
          { sourceLabel: doc.fileName, fieldName: 'Extraction Confidence', value: docConf },
        ],
        evidenceSource: 'Document Intelligence OCR Confidence',
        extractionConfidence: docConf,
        recommendedAction: 'Inspect the uploaded file directly and replace with a higher-resolution scan if numbers or names are unclear.',
      });
    }

    // E2. Missing / Unreadable fields & Missing pages hints
    if ((analysis.missingFields && analysis.missingFields.length > 0) || (analysis.unreadableFields && analysis.unreadableFields.length > 0)) {
      const missingList = analysis.missingFields ?? [];
      const unreadList = analysis.unreadableFields ?? [];
      addFinding({
        keySeed: `missingfields:${doc.id}`,
        category: 'Document Completeness',
        severity: 'Medium',
        title: `Missing or unreadable fields in ${doc.fileName}`,
        description: `Required fields could not be read cleanly in ${doc.documentType}: ${[...missingList, ...unreadList].join(', ')}.`,
        affectedDocuments: affected,
        conflictingValues: [
          ...(missingList.length > 0
            ? [{ sourceLabel: doc.fileName, fieldName: 'Missing Fields', value: missingList.join(', ') }]
            : []),
          ...(unreadList.length > 0
            ? [{ sourceLabel: doc.fileName, fieldName: 'Unreadable Fields', value: unreadList.join(', ') }]
            : []),
        ],
        evidenceSource: 'Document Intelligence Field Completeness',
        extractionConfidence: docConf,
        recommendedAction: 'Check that all pages (including back side or seal/signature page) are included and clearly visible.',
      });
    }

    if (typeof doc.pageCount === 'number' && doc.pageCount === 0) {
      addFinding({
        keySeed: `pages:${doc.id}`,
        category: 'Document Completeness',
        severity: 'Medium',
        title: `Missing pages indicator on ${doc.fileName}`,
        description: `Zero readable pages were counted for "${doc.fileName}".`,
        affectedDocuments: affected,
        conflictingValues: [{ sourceLabel: doc.fileName, fieldName: 'Page Count', value: '0' }],
        evidenceSource: 'PDF Page Inspection',
        extractionConfidence: docConf,
        recommendedAction: 'Re-upload the complete multi-page PDF document.',
      });
    }

    // E3. Explicit expiry warnings or outdated dates
    if (analysis.expiryWarning?.trim()) {
      addFinding({
        keySeed: `expiry-warn:${doc.id}`,
        category: role === 'income' ? 'Income Consistency' : 'Document Completeness',
        severity: 'High',
        title: `Potentially expired or time-sensitive certificate: ${doc.fileName}`,
        description: analysis.expiryWarning.trim(),
        affectedDocuments: affected,
        conflictingValues: [
          { sourceLabel: doc.fileName, fieldName: 'Validity / Expiry Note', value: analysis.expiryWarning.trim() },
        ],
        evidenceSource: 'Document Validity Extraction',
        extractionConfidence: docConf,
        recommendedAction: 'Verify the certificate issue date and Financial Year / validity window on the official portal and renew via e-District/Tehsildar if expired.',
      });
    } else {
      const validUntilField = findExtractedField(fields, (n) =>
        n.includes('valid') || n.includes('expiry') || n.includes('expires')
      );
      const issueDateField = findExtractedField(fields, (n) =>
        n.includes('issue date') || n.includes('date of issue') || n.includes('issued on')
      );
      if (validUntilField) {
        const validIso = normalizeDateIso(validUntilField.value);
        const todayIso = referenceDate.toISOString().slice(0, 10);
        if (validIso && validIso < todayIso) {
          checked.add('Certificate Validity');
          addFinding({
            keySeed: `expired-date:${doc.id}`,
            category: role === 'income' ? 'Income Consistency' : 'Document Completeness',
            severity: 'High',
            title: `Expired validity date detected on ${doc.fileName}`,
            description: `Extracted validity end date (${validUntilField.value}) is earlier than today (${todayIso}). Many Indian scholarship portals reject expired certificates.`,
            affectedDocuments: affected,
            conflictingValues: [
              { sourceLabel: doc.fileName, fieldName: validUntilField.fieldName, value: validUntilField.value },
              { sourceLabel: 'Reference Date', fieldName: 'Current Date', value: todayIso },
            ],
            evidenceSource: 'Extracted Validity Date',
            extractionConfidence: validUntilField.confidence,
            recommendedAction: `Obtain a renewed ${doc.documentType} from the competent authority before submitting applications.`,
          });
        }
      } else if (role === 'income' && issueDateField) {
        const issueIso = normalizeDateIso(issueDateField.value);
        if (issueIso) {
          checked.add('Certificate Issue Date');
          const issueTs = Date.parse(issueIso);
          const ageMonths = (referenceDate.getTime() - issueTs) / (1000 * 60 * 60 * 24 * 30.44);
          if (ageMonths > TRUSTGUARD_RULE_CONFIG.incomeCertificateMaxAgeMonths) {
            addFinding({
              keySeed: `income-old:${doc.id}`,
              category: 'Income Consistency',
              severity: 'Medium',
              title: `Potentially outdated Income Certificate (${doc.fileName})`,
              description: `Income certificate issue date (${issueDateField.value}) is over ${Math.floor(ageMonths)} months old. Most NSP and State scholarship cycles require a current Financial Year Income Certificate.`,
              affectedDocuments: affected,
              conflictingValues: [
                { sourceLabel: doc.fileName, fieldName: issueDateField.fieldName, value: issueDateField.value },
              ],
              evidenceSource: 'Income Certificate Issue Date',
              extractionConfidence: issueDateField.confidence,
              recommendedAction: 'Confirm whether your scholarship portal accepts this Financial Year certificate or renew via Tehsildar/e-District.',
            });
          }
        }
      }
    }

    // A. Identity Consistency (applicable to docs carrying holder name / DOB / parent name)
    const nameField = findExtractedField(fields, (n) => {
      if (n.includes('father') || n.includes('mother') || n.includes('parent') || n.includes('guardian') || n.includes('authority') || n.includes('officer') || n.includes('school') || n.includes('institution') || n.includes('college') || n.includes('bank')) {
        return false;
      }
      return n.includes('name') || n.includes('candidate') || n.includes('applicant') || n.includes('beneficiary') || n.includes('holder');
    });

    if (nameField) {
      checked.add('Student Name');
      if (profile?.fullName?.trim()) {
        comparisonPerformedCount += 1;
        const nameCmp = compareNames(profile.fullName, nameField.value);
        const lowConf = isLowConfidenceContext(nameField.confidence, docConf, readability);

        if (nameCmp === 'mismatch') {
          addFinding({
            keySeed: `name-mismatch:${doc.id}`,
            category: 'Identity Consistency',
            severity: lowConf ? 'Medium' : 'High',
            title: lowConf
              ? `Manual review recommended: Name on ${doc.fileName}`
              : `Information mismatch detected: Student Name (${doc.fileName})`,
            description: lowConf
              ? `Low-confidence extraction read "${nameField.value}" on ${doc.fileName}, which differs from your profile name "${profile.fullName}". Manual verification recommended before flagging an actual conflict.`
              : `Extracted name "${nameField.value}" on ${doc.fileName} does not match your saved Student Profile name "${profile.fullName}".`,
            affectedDocuments: affected,
            conflictingValues: [
              { sourceLabel: 'Student Profile', fieldName: 'Full Name', value: profile.fullName },
              { sourceLabel: doc.fileName, fieldName: nameField.fieldName, value: nameField.value },
            ],
            evidenceSource: 'Document Intelligence + Student Profile',
            extractionConfidence: nameField.confidence,
            recommendedAction:
              'Verify spelling across your Aadhaar, Marksheet, and Profile. Correct any profile typo or verify official certificate spelling before NSP OTR KYC.',
          });
        } else if (nameCmp === 'partial_or_initial') {
          addFinding({
            keySeed: `name-partial:${doc.id}`,
            category: 'Identity Consistency',
            severity: 'Low',
            title: `Minor name format / middle-initial variation on ${doc.fileName}`,
            description: `Document displays "${nameField.value}" while Student Profile lists "${profile.fullName}". Confirm whether portals requiring exact Aadhaar-to-Bank-to-Marksheet name matching accept this formatting.`,
            affectedDocuments: affected,
            conflictingValues: [
              { sourceLabel: 'Student Profile', fieldName: 'Full Name', value: profile.fullName },
              { sourceLabel: doc.fileName, fieldName: nameField.fieldName, value: nameField.value },
            ],
            evidenceSource: 'Document Intelligence + Student Profile',
            extractionConfidence: nameField.confidence,
            recommendedAction: 'Ensure initials/surname order matches Aadhaar e-KYC where strict biometric verification is enforced.',
          });
        }
      }
    }

    // DOB check (Identity, Academic, Caste, Domicile, Disability)
    if (role === 'identity' || role === 'academic' || role === 'caste' || role === 'domicile' || role === 'disability') {
      const dobField = findExtractedField(fields, (n) => n.includes('birth') || n === 'dob' || n.includes('d.o.b'));
      if (dobField) {
        checked.add('Date of Birth');
        const docIso = normalizeDateIso(dobField.value);
        if (docIso) {
          dobByDoc.push({ doc, iso: docIso, raw: dobField.value, conf: dobField.confidence });
          if (profile?.dateOfBirth?.trim()) {
            const profIso = normalizeDateIso(profile.dateOfBirth);
            if (profIso) {
              comparisonPerformedCount += 1;
              if (profIso !== docIso) {
                const lowConf = isLowConfidenceContext(dobField.confidence, docConf, readability);
                addFinding({
                  keySeed: `dob-mismatch:${doc.id}`,
                  category: 'Identity Consistency',
                  severity: lowConf ? 'Medium' : 'High',
                  title: lowConf
                    ? `Manual review recommended: Date of Birth on ${doc.fileName}`
                    : `Information mismatch detected: Date of Birth (${doc.fileName})`,
                  description: lowConf
                    ? `Low-confidence extraction read DOB "${dobField.value}" on ${doc.fileName} vs profile DOB "${profile.dateOfBirth}". Inspect scan clarity before updating records.`
                    : `Date of birth extracted from ${doc.fileName} (${docIso}) differs from your Student Profile (${profIso}).`,
                  affectedDocuments: affected,
                  conflictingValues: [
                    { sourceLabel: 'Student Profile', fieldName: 'Date of Birth', value: profile.dateOfBirth },
                    { sourceLabel: doc.fileName, fieldName: dobField.fieldName, value: dobField.value },
                  ],
                  evidenceSource: 'Document Intelligence + Student Profile',
                  extractionConfidence: dobField.confidence,
                  recommendedAction:
                    'Compare your Class 10 Marksheet and Aadhaar DOB; update Profile DOB if misentered or get official record corrected before applying.',
                });
              }
            }
          }
        }
      }
    }

    // Parent / Guardian Name collector for cross-document check
    const parentField = findExtractedField(fields, (n) =>
      n.includes('father') || n.includes('mother') || n.includes('parent') || n.includes('guardian')
    );
    if (parentField) {
      checked.add('Parent / Guardian Name');
      parentNamesByDoc.push({ doc, value: parentField.value, conf: parentField.confidence });
    }

    // B. Academic Consistency (Marksheet / Bonafide / Admission only)
    if (role === 'academic' || role === 'bonafide' || role === 'admission') {
      const rollField = findExtractedField(fields, (n) => n.includes('roll') || n.includes('registration no'));
      if (rollField) {
        checked.add('Roll / Registration Number');
        rollNumsByDoc.push({
          doc,
          roll: rollField.value.trim(),
          level: analysis.marksheetSummary?.examClassOrLevel ?? doc.documentType,
        });
      }

      const instField = findExtractedField(fields, (n) =>
        n.includes('institution') || n.includes('college') || n.includes('school') || n.includes('university')
      );
      if (instField && (role === 'bonafide' || role === 'admission') && profile?.institutionName?.trim()) {
        checked.add('Institution Name');
        comparisonPerformedCount += 1;
        const profInst = profile.institutionName.toLowerCase().trim();
        const docInst = instField.value.toLowerCase().trim();
        const sharedWords = profInst
          .split(/\s+/)
          .filter((w) => w.length >= 4 && docInst.includes(w));
        if (!docInst.includes(profInst) && !profInst.includes(docInst) && sharedWords.length === 0) {
          const lowConf = isLowConfidenceContext(instField.confidence, docConf, readability);
          addFinding({
            keySeed: `inst-mismatch:${doc.id}`,
            category: 'Academic Consistency',
            severity: lowConf ? 'Medium' : 'High',
            title: `Institution mismatch on ${doc.fileName}`,
            description: `Current enrollment document lists "${instField.value}", whereas your profile specifies "${profile.institutionName}".`,
            affectedDocuments: affected,
            conflictingValues: [
              { sourceLabel: 'Student Profile', fieldName: 'Institution Name', value: profile.institutionName },
              { sourceLabel: doc.fileName, fieldName: instField.fieldName, value: instField.value },
            ],
            evidenceSource: 'Document Intelligence + Student Profile',
            extractionConfidence: instField.confidence,
            recommendedAction: 'Update your current Institution Name in Profile or upload the current academic year Bonafide Certificate.',
          });
        }
      }

      if (role === 'academic' && analysis.marksheetSummary) {
        const ms = analysis.marksheetSummary;
        checked.add('Subject Totals & Aggregate');

        // B1. Subject-wise arithmetic discrepancies (Theory + Internal != Printed Total)
        const arithmeticErrors = ms.subjects.filter((s) => s.hasArithmeticDiscrepancy);
        if (arithmeticErrors.length > 0) {
          addFinding({
            keySeed: `ms-arith:${doc.id}`,
            category: 'Academic Consistency',
            severity: docConf === 'Low' ? 'Medium' : 'High',
            title: `Subject mark arithmetic discrepancy in ${doc.fileName}`,
            description: `Theory + Internal marks do not equal printed total for: ${arithmeticErrors.map((s) => s.subjectName).join(', ')}.`,
            affectedDocuments: affected,
            conflictingValues: arithmeticErrors.slice(0, 4).map((s) => ({
              sourceLabel: doc.fileName,
              fieldName: s.subjectName,
              value: `Printed ${s.printedTotalMarks} vs Theory(${s.theoryMarks ?? 0}) + Internal(${s.internalOrPracticalMarks ?? 0}) = ${s.calculatedTotalMarks}`,
            })),
            evidenceSource: 'Marksheet Subject Calculator',
            extractionConfidence: docConf,
            recommendedAction: 'Inspect the subject marks table in Document Intelligence and correct any misread OCR values.',
          });
        }

        // B2. Main vs Additional subject grouping / confirmation check
        if (ms.requiresUserConfirmation) {
          addFinding({
            keySeed: `ms-confirm:${doc.id}`,
            category: 'Academic Consistency',
            severity: 'Medium',
            title: `Marksheet subject selection needs confirmation (${doc.fileName})`,
            description:
              ms.confirmationReasons[0] ||
              'Applicable board rule or main vs. additional subject grouping needs student confirmation before finalizing overall percentage.',
            affectedDocuments: affected,
            conflictingValues: [
              {
                sourceLabel: doc.fileName,
                fieldName: 'Assessment Rule',
                value: ms.applicableRule,
              },
              ...(ms.mainAggregate
                ? [{
                    sourceLabel: doc.fileName,
                    fieldName: 'Main Aggregate (Pending)',
                    value: `${ms.mainAggregate.obtainedMarks}/${ms.mainAggregate.maximumMarks} (${ms.mainAggregate.percentage}%)`,
                  }]
                : []),
            ],
            evidenceSource: 'Marksheet Aggregate Calculator',
            extractionConfidence: docConf,
            recommendedAction: 'Open Document Intelligence and confirm which subjects are Main vs. Additional.',
          });
        }

        // B3. Compare mainAggregate.percentage vs profile.previousMarksPercent & scholarship cutoffs
        if (ms.mainAggregate && typeof profile?.previousMarksPercent === 'number') {
          checked.add('Overall Percentage vs Profile');
          comparisonPerformedCount += 1;
          const diff = Math.abs(ms.mainAggregate.percentage - profile.previousMarksPercent);

          // Check if profile marks matched aggregateIncludingAdditional instead of CBSE main 5-subject aggregate
          const matchesAdditionalInstead =
            ms.aggregateIncludingAdditional &&
            Math.abs(ms.aggregateIncludingAdditional.percentage - profile.previousMarksPercent) <= 0.5 &&
            diff > TRUSTGUARD_RULE_CONFIG.marksTolerancePercent;

          if (diff > TRUSTGUARD_RULE_CONFIG.marksTolerancePercent) {
            const impactedSchemes = relevantSchemes.filter(
              (r) =>
                typeof r.scholarship.minMarksPercent === 'number' &&
                r.scholarship.minMarksPercent > 0 &&
                ((profile.previousMarksPercent! >= r.scholarship.minMarksPercent &&
                  ms.mainAggregate!.percentage < r.scholarship.minMarksPercent) ||
                  (ms.mainAggregate!.percentage < r.scholarship.minMarksPercent))
            );
            const isCritical = impactedSchemes.some(
              (r) =>
                profile.previousMarksPercent! >= (r.scholarship.minMarksPercent ?? 0) &&
                ms.mainAggregate!.percentage < (r.scholarship.minMarksPercent ?? 0)
            );

            addFinding({
              keySeed: `marks-mismatch:${doc.id}`,
              category: 'Academic Consistency',
              severity: docConf === 'Low' ? 'Medium' : isCritical ? 'Critical' : 'High',
              title: matchesAdditionalInstead
                ? `Profile percentage includes additional subject instead of ${ms.mainAggregate.label}`
                : `Information mismatch detected: Academic Marks % (${doc.fileName})`,
              description: matchesAdditionalInstead
                ? `Student Profile records ${profile.previousMarksPercent}%, which matches the additional-inclusive aggregate (${ms.aggregateIncludingAdditional!.percentage}%), whereas ${ms.applicableRule} gives ${ms.mainAggregate.percentage}% (${ms.mainAggregate.obtainedMarks}/${ms.mainAggregate.maximumMarks}).`
                : `Calculated ${ms.mainAggregate.label} is ${ms.mainAggregate.percentage}% (${ms.mainAggregate.obtainedMarks}/${ms.mainAggregate.maximumMarks}), differing from your Student Profile (${profile.previousMarksPercent}%).`,
              affectedDocuments: affected,
              conflictingValues: [
                {
                  sourceLabel: 'Student Profile',
                  fieldName: 'Previous Qualifying Marks (%)',
                  value: `${profile.previousMarksPercent}%`,
                },
                {
                  sourceLabel: doc.fileName,
                  fieldName: `${ms.mainAggregate.label} (${ms.mainAggregate.sourceType === 'ai-calculated' ? 'AI-Calculated' : 'Document-Extracted'})`,
                  value: `${ms.mainAggregate.percentage}% (${ms.mainAggregate.obtainedMarks}/${ms.mainAggregate.maximumMarks})`,
                },
                ...(ms.aggregateIncludingAdditional
                  ? [{
                      sourceLabel: doc.fileName,
                      fieldName: ms.aggregateIncludingAdditional.label,
                      value: `${ms.aggregateIncludingAdditional.percentage}% (${ms.aggregateIncludingAdditional.obtainedMarks}/${ms.aggregateIncludingAdditional.maximumMarks})`,
                    }]
                  : []),
              ],
              evidenceSource: 'Marksheet Calculator + Student Profile',
              extractionConfidence: docConf,
              recommendedAction:
                'Update your Profile Previous Marks (%) to match the board-applicable main aggregate or confirm subject selection in Document Intelligence.',
              relatedScholarshipIds: impactedSchemes.map((i) => i.scholarship.id),
              relatedScholarshipTitles: impactedSchemes.map((i) => i.scholarship.title),
            });
          }
        }
      }
    }

    // C. Income Consistency (Income Certificate only)
    if (role === 'income') {
      if (!analysis.issuingAuthority?.trim() || analysis.issuingAuthority.toLowerCase().includes('not clear')) {
        checked.add('Issuing Authority');
        addFinding({
          keySeed: `income-auth:${doc.id}`,
          category: 'Income Consistency',
          severity: 'Medium',
          title: `Issuing authority unclear on Income Certificate (${doc.fileName})`,
          description: `Competent issuing authority (e.g., Tehsildar / Revenue Officer / SDM) was not clearly extracted from ${doc.fileName}.`,
          affectedDocuments: affected,
          conflictingValues: [
            {
              sourceLabel: doc.fileName,
              fieldName: 'Issuing Authority',
              value: analysis.issuingAuthority || 'Absent / Unclear',
            },
          ],
          evidenceSource: 'Income Certificate Header/Seal Extraction',
          extractionConfidence: docConf,
          recommendedAction: 'Confirm that the certificate is signed/sealed by a competent revenue authority (Tehsildar/SDM/e-District).',
        });
      }

      const incomeField = findExtractedField(fields, (n) =>
        n.includes('income') || n.includes('annual family income') || n.includes('total income')
      );
      if (incomeField) {
        checked.add('Annual Family Income');
        const extractedInr = parseNumericInr(incomeField.value);
        if (extractedInr !== null && typeof profile?.familyAnnualIncomeInr === 'number') {
          comparisonPerformedCount += 1;
          const diff = Math.abs(extractedInr - profile.familyAnnualIncomeInr);
          const relThreshold = Math.max(
            TRUSTGUARD_RULE_CONFIG.incomeAbsoluteToleranceInr,
            profile.familyAnnualIncomeInr * TRUSTGUARD_RULE_CONFIG.incomeRelativeToleranceRatio
          );

          if (diff > relThreshold) {
            const lowConf = isLowConfidenceContext(incomeField.confidence, docConf, readability);
            const impactedSchemes = relevantSchemes.filter(
              (r) =>
                typeof r.scholarship.incomeLimitInr === 'number' &&
                ((profile.familyAnnualIncomeInr! <= r.scholarship.incomeLimitInr &&
                  extractedInr > r.scholarship.incomeLimitInr) ||
                  extractedInr > r.scholarship.incomeLimitInr)
            );
            const crossesCutoff = impactedSchemes.some(
              (r) =>
                profile.familyAnnualIncomeInr! <= (r.scholarship.incomeLimitInr ?? Infinity) &&
                extractedInr > (r.scholarship.incomeLimitInr ?? Infinity)
            );

            addFinding({
              keySeed: `income-mismatch:${doc.id}`,
              category: 'Income Consistency',
              severity: lowConf ? 'Medium' : crossesCutoff ? 'Critical' : 'High',
              title: lowConf
                ? `Manual review recommended: Annual Income on ${doc.fileName}`
                : `Information mismatch detected: Annual Family Income (${doc.fileName})`,
              description: lowConf
                ? `Low-confidence extraction read ₹${extractedInr.toLocaleString('en-IN')} vs declared profile income ₹${profile.familyAnnualIncomeInr.toLocaleString('en-IN')}. Review the scan manually.`
                : `Extracted annual income on ${doc.fileName} is ₹${extractedInr.toLocaleString('en-IN')}, whereas your Student Profile declares ₹${profile.familyAnnualIncomeInr.toLocaleString('en-IN')}.`,
              affectedDocuments: affected,
              conflictingValues: [
                {
                  sourceLabel: 'Student Profile',
                  fieldName: 'Family Annual Income (INR)',
                  value: `₹${profile.familyAnnualIncomeInr.toLocaleString('en-IN')}`,
                },
                {
                  sourceLabel: doc.fileName,
                  fieldName: incomeField.fieldName,
                  value: `₹${extractedInr.toLocaleString('en-IN')} (${incomeField.value})`,
                },
              ],
              evidenceSource: 'Income Certificate Extraction + Student Profile',
              extractionConfidence: incomeField.confidence,
              recommendedAction:
                'Review your declared family income in Profile and verify the uploaded Income Certificate reflects your current official Financial Year assessment.',
              relatedScholarshipIds: impactedSchemes.map((i) => i.scholarship.id),
              relatedScholarshipTitles: impactedSchemes.map((i) => i.scholarship.title),
            });
          }
        }
      }
    }

    // D. Category & Residence Consistency
    if (role === 'caste') {
      const catField = findExtractedField(fields, (n) =>
        n.includes('category') || n.includes('caste') || n.includes('community') || n.includes('quota')
      );
      if (catField && profile?.category) {
        checked.add('Social Category');
        const docCat = normalizeCategoryToken(catField.value);
        if (docCat) {
          comparisonPerformedCount += 1;
          const compatible =
            docCat === profile.category ||
            (docCat === 'OBC' && profile.category === 'OBC-NCL');
          if (!compatible) {
            const lowConf = isLowConfidenceContext(catField.confidence, docConf, readability);
            const impactedSchemes = relevantSchemes.filter(
              (r) =>
                r.scholarship.allowedCategories &&
                r.scholarship.allowedCategories.length < 6
            );
            addFinding({
              keySeed: `category-mismatch:${doc.id}`,
              category: 'Category & Residence Consistency',
              severity: lowConf ? 'Medium' : 'High',
              title: lowConf
                ? `Manual review recommended: Social Category on ${doc.fileName}`
                : `Category information discrepancy (${doc.fileName})`,
              description: `Certificate mentions category "${catField.value}" (${docCat}), whereas Student Profile selects "${profile.category}".`,
              affectedDocuments: affected,
              conflictingValues: [
                { sourceLabel: 'Student Profile', fieldName: 'Social Category', value: profile.category },
                { sourceLabel: doc.fileName, fieldName: catField.fieldName, value: catField.value },
              ],
              evidenceSource: 'Caste/Category Certificate + Student Profile',
              extractionConfidence: catField.confidence,
              recommendedAction: 'Ensure your Profile Social Category matches your valid central/state category certificate.',
              relatedScholarshipIds: impactedSchemes.map((i) => i.scholarship.id),
              relatedScholarshipTitles: impactedSchemes.map((i) => i.scholarship.title),
            });
          }
        }
      }
    }

    if (role === 'domicile' || role === 'identity' || role === 'income' || role === 'caste') {
      const stateField = findExtractedField(fields, (n) => n.includes('state') || n.includes('domicile') || n.includes('ut'));
      if (stateField) {
        checked.add('Domicile State');
        const docStateNorm = normalizeStateName(stateField.value);
        domicileStatesByDoc.push({
          doc,
          stateNorm: docStateNorm,
          raw: stateField.value,
          conf: stateField.confidence,
        });

        if (profile?.state?.trim() && (role === 'domicile' || role === 'income' || role === 'caste')) {
          comparisonPerformedCount += 1;
          const profStateNorm = normalizeStateName(profile.state);
          if (docStateNorm && profStateNorm && !docStateNorm.includes(profStateNorm) && !profStateNorm.includes(docStateNorm)) {
            const lowConf = isLowConfidenceContext(stateField.confidence, docConf, readability);
            const impactedSchemes = relevantSchemes.filter(
              (r) =>
                r.scholarship.eligibleStates &&
                !r.scholarship.eligibleStates.includes('All India')
            );
            addFinding({
              keySeed: `state-mismatch:${doc.id}`,
              category: 'Category & Residence Consistency',
              severity: lowConf ? 'Medium' : role === 'domicile' ? 'High' : 'Medium',
              title: `Domicile / State discrepancy (${doc.fileName})`,
              description: `${doc.documentType} lists state "${stateField.value}", whereas your Student Profile selects domicile state "${profile.state}".`,
              affectedDocuments: affected,
              conflictingValues: [
                { sourceLabel: 'Student Profile', fieldName: 'Domicile State', value: profile.state },
                { sourceLabel: doc.fileName, fieldName: stateField.fieldName, value: stateField.value },
              ],
              evidenceSource: 'Document Intelligence + Student Profile',
              extractionConfidence: stateField.confidence,
              recommendedAction: 'Confirm your permanent domicile state for state-domiciled scholarships (e.g., MahaDBT / State DBT).',
              relatedScholarshipIds: impactedSchemes.map((i) => i.scholarship.id),
              relatedScholarshipTitles: impactedSchemes.map((i) => i.scholarship.title),
            });
          }
        }
      }

      const districtField = findExtractedField(fields, (n) => n.includes('district'));
      if (districtField && profile?.district?.trim() && (role === 'domicile' || role === 'income')) {
        checked.add('District');
        comparisonPerformedCount += 1;
        const docDist = districtField.value.toLowerCase().trim();
        const profDist = profile.district.toLowerCase().trim();
        if (docDist && profDist && !docDist.includes(profDist) && !profDist.includes(docDist)) {
          const lowConf = isLowConfidenceContext(districtField.confidence, docConf, readability);
          addFinding({
            keySeed: `district-mismatch:${doc.id}`,
            category: 'Category & Residence Consistency',
            severity: lowConf ? 'Low' : 'Medium',
            title: `District mismatch (${doc.fileName})`,
            description: `Certificate specifies district "${districtField.value}", while Student Profile indicates "${profile.district}".`,
            affectedDocuments: affected,
            conflictingValues: [
              { sourceLabel: 'Student Profile', fieldName: 'District', value: profile.district },
              { sourceLabel: doc.fileName, fieldName: districtField.fieldName, value: districtField.value },
            ],
            evidenceSource: 'Document Intelligence + Student Profile',
            extractionConfidence: districtField.confidence,
            recommendedAction: 'Verify district alignment if your scholarship requires district-level nodal officer approval.',
          });
        }
      }
    }

    // Surface explicit profileMismatches recorded by Phase 4 extractor if not already caught by a specific structured rule
    if (analysis.profileMismatches && analysis.profileMismatches.length > 0) {
      for (const rawMismatch of analysis.profileMismatches) {
        const cleaned = rawMismatch.trim();
        if (!cleaned) continue;
        // Skip duplicating if we already logged a structured mismatch on the same doc + topic
        const lower = cleaned.toLowerCase();
        const alreadyCovered =
          (lower.includes('name') && findingsMap.has(`tgf-${stableHash(`name-mismatch:${doc.id}`)}`)) ||
          (lower.includes('income') && findingsMap.has(`tgf-${stableHash(`income-mismatch:${doc.id}`)}`)) ||
          (lower.includes('birth') && findingsMap.has(`tgf-${stableHash(`dob-mismatch:${doc.id}`)}`)) ||
          (lower.includes('mark') && findingsMap.has(`tgf-${stableHash(`marks-mismatch:${doc.id}`)}`)) ||
          (lower.includes('category') && findingsMap.has(`tgf-${stableHash(`category-mismatch:${doc.id}`)}`));

        if (!alreadyCovered) {
          comparisonPerformedCount += 1;
          addFinding({
            keySeed: `ai-mismatch:${doc.id}:${cleaned.slice(0, 48)}`,
            category: 'Identity Consistency',
            severity: docConf === 'Low' ? 'Low' : 'Medium',
            title: `Document consistency note (${doc.fileName})`,
            description: cleaned,
            affectedDocuments: affected,
            conflictingValues: [
              { sourceLabel: doc.fileName, fieldName: 'Profile Comparison Note', value: cleaned },
            ],
            evidenceSource: 'Document Intelligence Profile Check',
            extractionConfidence: docConf,
            recommendedAction: 'Review this extracted detail against your Profile before portal submission.',
          });
        }
      }
    }
  }

  // Cross-document comparisons (DOB, Parent Name, Domicile State, Duplicates)
  if (dobByDoc.length >= 2) {
    const distinctDobs = Array.from(new Set(dobByDoc.map((x) => x.iso)));
    if (distinctDobs.length > 1) {
      comparisonPerformedCount += 1;
      addFinding({
        keySeed: `cross-dob:${dobByDoc.map((d) => d.doc.id).sort().join(':')}`,
        category: 'Identity Consistency',
        severity: 'High',
        title: 'Cross-document Date of Birth mismatch',
        description: `Uploaded documents contain conflicting Dates of Birth (${distinctDobs.join(' vs ')}).`,
        affectedDocuments: dobByDoc.map((d) => ({
          documentId: d.doc.id,
          fileName: d.doc.fileName,
          documentType: d.doc.documentType,
        })),
        conflictingValues: dobByDoc.map((d) => ({
          sourceLabel: d.doc.fileName,
          fieldName: 'Date of Birth',
          value: `${d.raw} (normalized ${d.iso})`,
        })),
        evidenceSource: 'Cross-Document Identity Comparison',
        extractionConfidence: dobByDoc.some((d) => d.conf === 'Low') ? 'Low' : 'High',
        recommendedAction: 'Resolve DOB discrepancies between Aadhaar and Class 10 Marksheet before Aadhaar OTR verification.',
      });
    }
  }

  if (parentNamesByDoc.length >= 2) {
    const first = parentNamesByDoc[0];
    const mismatched = parentNamesByDoc.slice(1).filter(
      (other) => compareNames(first.value, other.value) === 'mismatch'
    );
    if (mismatched.length > 0) {
      comparisonPerformedCount += 1;
      const group = [first, ...mismatched];
      const anyLow = group.some((g) => g.conf === 'Low');
      addFinding({
        keySeed: `cross-parent:${group.map((g) => g.doc.id).sort().join(':')}`,
        category: 'Identity Consistency',
        severity: anyLow ? 'Medium' : 'High',
        title: anyLow
          ? 'Manual review recommended: Parent / Guardian Name across documents'
          : 'Parent or Guardian name mismatch across uploaded documents',
        description: 'Parent/guardian names extracted from uploaded certificates do not match consistently.',
        affectedDocuments: group.map((g) => ({
          documentId: g.doc.id,
          fileName: g.doc.fileName,
          documentType: g.doc.documentType,
        })),
        conflictingValues: group.map((g) => ({
          sourceLabel: g.doc.fileName,
          fieldName: 'Parent / Guardian Name',
          value: g.value,
        })),
        evidenceSource: 'Cross-Document Family Details Check',
        extractionConfidence: anyLow ? 'Low' : 'Medium',
        recommendedAction: 'Confirm consistent parent/guardian spelling across Income Certificate, Caste Certificate, and Marksheet.',
      });
    }
  }

  if (domicileStatesByDoc.length >= 2) {
    const first = domicileStatesByDoc[0];
    const diffState = domicileStatesByDoc.slice(1).filter(
      (s) => s.stateNorm && first.stateNorm && !s.stateNorm.includes(first.stateNorm) && !first.stateNorm.includes(s.stateNorm)
    );
    if (diffState.length > 0) {
      comparisonPerformedCount += 1;
      const group = [first, ...diffState];
      addFinding({
        keySeed: `cross-state:${group.map((g) => g.doc.id).sort().join(':')}`,
        category: 'Category & Residence Consistency',
        severity: 'Medium',
        title: 'Conflicting states across uploaded documents',
        description: 'Different state names appear across uploaded identity or residence certificates.',
        affectedDocuments: group.map((g) => ({
          documentId: g.doc.id,
          fileName: g.doc.fileName,
          documentType: g.doc.documentType,
        })),
        conflictingValues: group.map((g) => ({
          sourceLabel: g.doc.fileName,
          fieldName: 'State / Domicile',
          value: g.raw,
        })),
        evidenceSource: 'Cross-Document Domicile Check',
        extractionConfidence: group.some((g) => g.conf === 'Low') ? 'Low' : 'Medium',
        recommendedAction: 'Clarify permanent domicile vs. current college state if applying to state-domiciled scholarships.',
      });
    }
  }

  // Roll number conflict check (same exam level)
  if (rollNumsByDoc.length >= 2) {
    const byLevel = new Map<string, typeof rollNumsByDoc>();
    for (const item of rollNumsByDoc) {
      const key = item.level.toLowerCase();
      const arr = byLevel.get(key) ?? [];
      arr.push(item);
      byLevel.set(key, arr);
    }
    byLevel.forEach((group, lvl) => {
      const distinctRolls = Array.from(new Set(group.map((g) => g.roll.toLowerCase())));
      if (group.length >= 2 && distinctRolls.length > 1) {
        addFinding({
          keySeed: `cross-roll:${lvl}:${group.map((g) => g.doc.id).sort().join(':')}`,
          category: 'Academic Consistency',
          severity: 'Medium',
          title: `Conflicting roll/registration numbers for ${lvl}`,
          description: 'Multiple documents for the same academic stage report different roll or registration numbers.',
          affectedDocuments: group.map((g) => ({
            documentId: g.doc.id,
            fileName: g.doc.fileName,
            documentType: g.doc.documentType,
          })),
          conflictingValues: group.map((g) => ({
            sourceLabel: g.doc.fileName,
            fieldName: 'Roll / Registration Number',
            value: g.roll,
          })),
          evidenceSource: 'Cross-Document Academic Check',
          extractionConfidence: 'Medium',
          recommendedAction: 'Verify that you uploaded documents for the right academic year and student.',
        });
      }
    });
  }

  // Duplicate upload findings
  seenDocsByKey.forEach((group) => {
    if (group.length > 1) {
      addFinding({
        keySeed: `duplicate:${group.map((d) => d.id).sort().join(':')}`,
        category: 'Duplicate Upload',
        severity: 'Low',
        title: `Duplicate document upload detected (${group[0].fileName})`,
        description: `${group.length} uploads appear to represent the same ${group[0].documentType} file ("${group[0].fileName}"). Removing duplicate copies keeps your vault clean.`,
        affectedDocuments: group.map((d) => ({
          documentId: d.id,
          fileName: d.fileName,
          documentType: d.documentType,
        })),
        conflictingValues: group.map((d) => ({
          sourceLabel: d.fileName,
          fieldName: 'Uploaded At',
          value: d.createdAt,
        })),
        evidenceSource: 'Document Vault Duplicate Detection',
        extractionConfidence: 'High',
        recommendedAction: 'Delete outdated duplicate copies in Document Intelligence if they are redundant.',
      });
    }
  });

  // Tracked/Saved Scholarship Document Checklist Gaps
  for (const item of relevantSchemes.filter((s) => trackedSet.has(s.scholarship.id) || savedSet.has(s.scholarship.id))) {
    const missingForScheme = item.docComp.items.filter((i) => i.status === 'Missing');
    if (missingForScheme.length > 0 && isScholarshipSourceVerified(item.scholarship.verificationStatus)) {
      addFinding({
        keySeed: `sch-missing-docs:${item.scholarship.id}`,
        category: 'Scholarship Requirement Gap',
        severity: 'Low',
        title: `Missing required documents for ${item.scholarship.title}`,
        description: `${missingForScheme.length} mandatory document(s) required by this saved/tracked scheme have not been uploaded yet: ${missingForScheme.map((m) => m.requiredDocument).join(', ')}.`,
        affectedDocuments: [],
        conflictingValues: [
          {
            sourceLabel: item.scholarship.title,
            fieldName: 'Missing Required Uploads',
            value: missingForScheme.map((m) => m.requiredDocument).join(', '),
          },
        ],
        evidenceSource: 'Scholarship Required Document Checklist',
        extractionConfidence: 'High',
        recommendedAction: `Upload missing certificates (${missingForScheme.slice(0, 2).map((m) => m.requiredDocument).join(', ')}) in Document Intelligence.`,
        relatedScholarshipIds: [item.scholarship.id],
        relatedScholarshipTitles: [item.scholarship.title],
      });
    }
  }

  // Sort findings by severity descending
  const findings = Array.from(findingsMap.values()).sort(
    (a, b) =>
      TRUSTGUARD_RULE_CONFIG.severityWeights[b.severity] -
      TRUSTGUARD_RULE_CONFIG.severityWeights[a.severity]
  );

  // Severity counts
  const severityCounts: TrustGuardSeverityCounts = {
    critical: findings.filter((f) => f.severity === 'Critical').length,
    high: findings.filter((f) => f.severity === 'High').length,
    medium: findings.filter((f) => f.severity === 'Medium').length,
    low: findings.filter((f) => f.severity === 'Low').length,
    informational: findings.filter((f) => f.severity === 'Informational').length,
  };

  // Document-wise verification statuses
  const documentResults: TrustGuardDocumentResult[] = documents.map((doc) => {
    const analysis = latestAnalysisByDoc.get(doc.id);
    const docFindings = findings.filter((f) =>
      f.affectedDocuments.some((a) => a.documentId === doc.id)
    );
    const highestSeverity = docFindings[0]?.severity;
    const checkedList = Array.from(docCheckedFields.get(doc.id) ?? []);

    let verificationStatus: TrustGuardVerificationStatus;
    if (doc.processingStatus === 'Pending' || doc.processingStatus === 'Processing') {
      verificationStatus = 'Analysis In Progress';
    } else if (doc.processingStatus === 'Failed' || analysis?.readabilityStatus === 'Unreadable') {
      verificationStatus = 'Unable to Verify';
    } else if (!analysis) {
      verificationStatus = 'Not Analyzed';
    } else if (
      docFindings.some(
        (f) =>
          (f.severity === 'Critical' || f.severity === 'High') &&
          (f.category === 'Identity Consistency' ||
            f.category === 'Academic Consistency' ||
            f.category === 'Income Consistency' ||
            f.category === 'Category & Residence Consistency')
      )
    ) {
      verificationStatus = 'Information Mismatch Detected';
    } else if (
      docFindings.some(
        (f) => f.severity === 'Critical' || f.severity === 'High' || f.severity === 'Medium'
      ) ||
      doc.processingStatus === 'Needs Review' ||
      analysis.readinessVerdict !== 'Ready'
    ) {
      verificationStatus = 'Manual Review Required';
    } else if (checkedList.length > 0 && comparisonPerformedCount > 0) {
      verificationStatus = 'Verified Against Available Records';
    } else {
      verificationStatus = 'Consistency Check Completed';
    }

    const summaryNote =
      docFindings.length > 0
        ? docFindings[0].title
        : checkedList.length > 0
          ? `Checked: ${checkedList.join(', ')}. No inconsistencies found against stored records.`
          : 'Document analysis completed with no risk flags.';

    return {
      documentId: doc.id,
      fileName: doc.fileName,
      documentType: doc.documentType,
      ...(analysis?.detectedType ? { detectedType: analysis.detectedType } : {}),
      verificationStatus,
      ...(doc.processingStatus ? { processingStatus: doc.processingStatus } : {}),
      ...(analysis?.readabilityStatus ? { readabilityStatus: analysis.readabilityStatus } : {}),
      ...(analysis?.overallConfidence ? { overallConfidence: analysis.overallConfidence } : {}),
      findingCount: docFindings.length,
      ...(highestSeverity ? { highestSeverity } : {}),
      summaryNote,
      checkedFields: checkedList,
    };
  });

  // Overall status classification
  let overallVerificationStatus: TrustGuardVerificationStatus;
  if (documentsAnalyzedCount === 0 && documentResults.some((d) => d.verificationStatus === 'Analysis In Progress')) {
    overallVerificationStatus = 'Analysis In Progress';
  } else if (documentsAnalyzedCount === 0 && documentResults.some((d) => d.verificationStatus === 'Unable to Verify')) {
    overallVerificationStatus = 'Unable to Verify';
  } else if (documentsAnalyzedCount === 0) {
    overallVerificationStatus = 'Not Analyzed';
  } else if (
    documentResults.some((d) => d.verificationStatus === 'Information Mismatch Detected')
  ) {
    overallVerificationStatus = 'Information Mismatch Detected';
  } else if (
    documentResults.some((d) => d.verificationStatus === 'Unable to Verify') &&
    documentResults.every((d) => d.verificationStatus === 'Unable to Verify')
  ) {
    overallVerificationStatus = 'Unable to Verify';
  } else if (
    documentResults.some(
      (d) =>
        d.verificationStatus === 'Manual Review Required' ||
        d.verificationStatus === 'Unable to Verify'
    )
  ) {
    overallVerificationStatus = 'Manual Review Required';
  } else if (
    documentResults.some((d) => d.verificationStatus === 'Analysis In Progress')
  ) {
    overallVerificationStatus = 'Analysis In Progress';
  } else if (
    comparisonPerformedCount > 0 &&
    documentResults.some((d) => d.verificationStatus === 'Verified Against Available Records')
  ) {
    overallVerificationStatus = 'Verified Against Available Records';
  } else {
    overallVerificationStatus = 'Consistency Check Completed';
  }

  // Corrective actions checklist (deduplicated)
  const correctiveActions = Array.from(
    new Set(findings.filter((f) => f.severity !== 'Informational').map((f) => f.recommendedAction))
  ).slice(0, 10);

  // Change summary relative to previous TrustGuard assessment (audit diff)
  let changeSummary: TrustGuardChangeSummary | undefined;
  if (previousAssessment) {
    const currentIds = new Set(findings.map((f) => f.findingId));
    const newFindingIds = findings
      .filter((f) => !prevFindingsById.has(f.findingId))
      .map((f) => f.findingId);
    const unchangedFindingIds = findings
      .filter((f) => prevFindingsById.has(f.findingId))
      .map((f) => f.findingId);
    const resolvedPrev = previousAssessment.findings.filter(
      (pf) => !currentIds.has(pf.findingId)
    );
    changeSummary = {
      previousAssessmentId: previousAssessment.id,
      previousAssessedAt: previousAssessment.createdAt,
      newFindingIds,
      resolvedFindingIds: resolvedPrev.map((r) => r.findingId),
      resolvedFindingTitles: resolvedPrev.map((r) => r.title),
      unchangedFindingIds,
    };
  }

  return {
    userId,
    analysisVersion: TRUSTGUARD_ALGORITHM_VERSION,
    dataFingerprint,
    overallVerificationStatus,
    documentsTotalCount: documents.length,
    documentsAnalyzedCount,
    severityCounts,
    documentResults,
    findings,
    correctiveActions,
    ...(changeSummary ? { changeSummary } : {}),
    limitationNotice: TRUSTGUARD_LIMITATION_NOTICE,
    disclaimer: TRUSTGUARD_DISCLAIMER,
  };
}
