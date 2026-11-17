import { isScholarshipSourceVerified } from './eligibilityEngine.ts';
import type {
  DocumentAnalysis,
  DocumentRecord,
  Scholarship,
  StudentProfile,
} from '../types/database.ts';

export type ScholarshipDocMatchStatus =
  | 'Ready'
  | 'Needs Review'
  | 'Processing'
  | 'Failed'
  | 'Missing';

export interface RequiredDocumentComparisonItem {
  requiredDocument: string;
  status: ScholarshipDocMatchStatus;
  matchedDocument?: DocumentRecord;
  matchedAnalysis?: DocumentAnalysis;
  notes: string[];
}

export interface ScholarshipDocumentReadinessReport {
  scholarshipId: string;
  scholarshipTitle: string;
  hasPublishedRequirements: boolean;
  isScholarshipVerified: boolean;
  limitationNotice?: string;
  readinessPercent: number;
  totalRequired: number;
  readyCount: number;
  needsReviewCount: number;
  missingCount: number;
  items: RequiredDocumentComparisonItem[];
}

function normalizeDocCategoryTokens(label: string): string[] {
  const lower = label.toLowerCase();
  const tokens: string[] = [];
  if (lower.includes('aadhaar') || lower.includes('identity') || lower.includes('id card')) {
    tokens.push('aadhaar', 'identity');
  }
  if (lower.includes('income')) tokens.push('income');
  if (lower.includes('caste') || lower.includes('category') || lower.includes('ews') || lower.includes('minority')) {
    tokens.push('caste', 'category', 'ews');
  }
  if (lower.includes('domicile') || lower.includes('residence')) tokens.push('domicile', 'residence');
  if (lower.includes('marksheet') || lower.includes('academic') || lower.includes('transcript')) {
    tokens.push('marksheet', 'academic');
  }
  if (lower.includes('bonafide')) tokens.push('bonafide');
  if (lower.includes('fee')) tokens.push('fee');
  if (lower.includes('admission')) tokens.push('admission');
  if (lower.includes('bank') || lower.includes('passbook')) tokens.push('bank', 'passbook');
  if (lower.includes('disability') || lower.includes('udid') || lower.includes('pwd')) {
    tokens.push('disability', 'udid');
  }
  return tokens;
}

function doesDocumentMatchRequirement(
  reqDoc: string,
  doc: DocumentRecord,
  analysis?: DocumentAnalysis
): boolean {
  const reqLower = reqDoc.toLowerCase();
  const docTypeLower = doc.documentType.toLowerCase();
  const detectedLower = (analysis?.detectedType ?? '').toLowerCase();

  if (reqLower === docTypeLower || reqLower.includes(docTypeLower) || docTypeLower.includes(reqLower)) {
    return true;
  }
  if (detectedLower && (reqLower.includes(detectedLower) || detectedLower.includes(reqLower))) {
    return true;
  }

  const reqTokens = normalizeDocCategoryTokens(reqDoc);
  const docTokens = new Set([
    ...normalizeDocCategoryTokens(doc.documentType),
    ...normalizeDocCategoryTokens(analysis?.detectedType ?? ''),
  ]);

  return reqTokens.some((tok) => docTokens.has(tok));
}

function parseNumericInrFromExtracted(value: string): number | null {
  const cleaned = value.replace(/,/g, '');
  const lakhMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:lakh|lac)/i);
  if (lakhMatch) {
    return Math.round(Number(lakhMatch[1]) * 100000);
  }
  const numMatch = cleaned.match(/\d{4,9}/);
  if (numMatch) {
    const val = Number(numMatch[0]);
    return Number.isFinite(val) ? val : null;
  }
  return null;
}

export function compareDocumentsAgainstScholarship(
  scholarship: Scholarship,
  documents: DocumentRecord[],
  analyses: DocumentAnalysis[],
  _profile: StudentProfile | null
): ScholarshipDocumentReadinessReport {
  const isScholarshipVerified = isScholarshipSourceVerified(scholarship.verificationStatus);
  const requiredDocs = scholarship.requiredDocuments ?? [];
  const hasPublishedRequirements = requiredDocs.length > 0;

  let limitationNotice: string | undefined;
  if (!isScholarshipVerified && !hasPublishedRequirements) {
    limitationNotice =
      `Scholarship verification status is "${scholarship.verificationStatus}" and no official required document checklist is stored yet. Check the official portal before preparing submissions.`;
  } else if (!isScholarshipVerified) {
    limitationNotice =
      `Scholarship verification status is "${scholarship.verificationStatus}". Confirm these listed document requirements directly on the official portal.`;
  } else if (!hasPublishedRequirements) {
    limitationNotice =
      'No structured required document checklist is currently published for this scholarship record. Verify mandatory uploads on the official portal.';
  }

  if (!hasPublishedRequirements) {
    return {
      scholarshipId: scholarship.id,
      scholarshipTitle: scholarship.title,
      hasPublishedRequirements: false,
      isScholarshipVerified,
      limitationNotice,
      readinessPercent: 0,
      totalRequired: 0,
      readyCount: 0,
      needsReviewCount: 0,
      missingCount: 0,
      items: [],
    };
  }

  // Latest analysis per document
  const latestAnalysisByDoc = new Map<string, DocumentAnalysis>();
  for (const a of analyses) {
    const existing = latestAnalysisByDoc.get(a.documentId);
    if (!existing || a.createdAt > existing.createdAt) {
      latestAnalysisByDoc.set(a.documentId, a);
    }
  }

  let scoreSum = 0;
  let readyCount = 0;
  let needsReviewCount = 0;
  let missingCount = 0;

  const items: RequiredDocumentComparisonItem[] = requiredDocs.map((reqDoc) => {
    const matchingDocs = documents.filter((d) =>
      doesDocumentMatchRequirement(reqDoc, d, latestAnalysisByDoc.get(d.id))
    );

    if (matchingDocs.length === 0) {
      missingCount += 1;
      return {
        requiredDocument: reqDoc,
        status: 'Missing',
        notes: [`No uploaded document matches "${reqDoc}".`],
      };
    }

    // Prefer a completed/ready document if multiple exist
    const sorted = [...matchingDocs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const chosenDoc =
      sorted.find((d) => d.processingStatus === 'Completed') ??
      sorted.find((d) => d.processingStatus === 'Needs Review') ??
      sorted[0];
    const analysis = latestAnalysisByDoc.get(chosenDoc.id);
    const notes: string[] = [];

    if (chosenDoc.processingStatus === 'Pending' || chosenDoc.processingStatus === 'Processing') {
      return {
        requiredDocument: reqDoc,
        status: 'Processing',
        matchedDocument: chosenDoc,
        matchedAnalysis: analysis,
        notes: ['Document is currently being parsed and analyzed.'],
      };
    }

    if (chosenDoc.processingStatus === 'Failed') {
      return {
        requiredDocument: reqDoc,
        status: 'Failed',
        matchedDocument: chosenDoc,
        matchedAnalysis: analysis,
        notes: [
          chosenDoc.errorDetails ||
            'Processing failed for this document. Replace the file or retry analysis.',
        ],
      };
    }

    // Check extracted income vs scholarship income cap if applicable
    if (
      typeof scholarship.incomeLimitInr === 'number' &&
      analysis?.extractedFields &&
      (reqDoc.toLowerCase().includes('income') ||
        chosenDoc.documentType.toLowerCase().includes('income'))
    ) {
      const incomeField = analysis.extractedFields.find(
        (f) =>
          f.status === 'Extracted' &&
          f.fieldName.toLowerCase().includes('income')
      );
      if (incomeField) {
        const parsedInr = parseNumericInrFromExtracted(incomeField.value);
        if (parsedInr !== null && parsedInr > scholarship.incomeLimitInr) {
          notes.push(
            `Extracted income (₹${parsedInr.toLocaleString('en-IN')}) exceeds this scholarship's ₹${scholarship.incomeLimitInr.toLocaleString('en-IN')} ceiling.`
          );
        }
      }
    }

    // Check extracted/calculated marksheet percentage vs scholarship minMarksPercent
    if (
      analysis?.marksheetSummary &&
      (reqDoc.toLowerCase().includes('marksheet') ||
        reqDoc.toLowerCase().includes('academic') ||
        reqDoc.toLowerCase().includes('transcript') ||
        chosenDoc.documentType.toLowerCase().includes('marksheet'))
    ) {
      const ms = analysis.marksheetSummary;
      if (ms.requiresUserConfirmation) {
        notes.push(
          `Marksheet subject selection or assessment rule needs confirmation before finalizing aggregate percentage.`
        );
      } else if (ms.mainAggregate) {
        const provenanceLabel =
          ms.mainAggregate.sourceType === 'ai-calculated' ? 'AI-Calculated' : 'Document-Extracted';
        if (
          typeof scholarship.minMarksPercent === 'number' &&
          ms.mainAggregate.percentage < scholarship.minMarksPercent
        ) {
          notes.push(
            `${ms.mainAggregate.label} (${ms.mainAggregate.percentage}% · ${ms.mainAggregate.obtainedMarks}/${ms.mainAggregate.maximumMarks}, ${provenanceLabel}) is below the ${scholarship.minMarksPercent}% minimum requirement.`
          );
        }
      }
    }

    if (analysis?.expiryWarning) {
      notes.push(`Validity warning: ${analysis.expiryWarning}`);
    }
    if (analysis?.profileMismatches && analysis.profileMismatches.length > 0) {
      notes.push(...analysis.profileMismatches.map((m) => `Profile mismatch: ${m}`));
    }
    if (analysis?.missingFields && analysis.missingFields.length > 0) {
      notes.push(`Missing fields in document: ${analysis.missingFields.join(', ')}`);
    }

    const needsAttention =
      chosenDoc.processingStatus === 'Needs Review' ||
      !analysis ||
      analysis.readinessVerdict !== 'Ready' ||
      analysis.readabilityStatus !== 'Readable' ||
      notes.length > 0;

    if (needsAttention) {
      needsReviewCount += 1;
      scoreSum += 0.5;
      if (notes.length === 0) {
        notes.push(
          analysis?.validityNotes ||
            'Document requires manual review before final portal submission.'
        );
      }
      return {
        requiredDocument: reqDoc,
        status: 'Needs Review',
        matchedDocument: chosenDoc,
        matchedAnalysis: analysis,
        notes,
      };
    }

    readyCount += 1;
    scoreSum += 1;
    notes.push(
      `Extracted via ${analysis.extractionMethod || 'document inspection'} (${analysis.overallConfidence || 'Medium'} confidence).`
    );
    return {
      requiredDocument: reqDoc,
      status: 'Ready',
      matchedDocument: chosenDoc,
      matchedAnalysis: analysis,
      notes,
    };
  });

  const readinessPercent = Math.round((scoreSum / requiredDocs.length) * 100);

  return {
    scholarshipId: scholarship.id,
    scholarshipTitle: scholarship.title,
    hasPublishedRequirements: true,
    isScholarshipVerified,
    limitationNotice,
    readinessPercent,
    totalRequired: requiredDocs.length,
    readyCount,
    needsReviewCount,
    missingCount,
    items,
  };
}
