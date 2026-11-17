import 'dotenv/config';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../src/data/verifiedScholarships.ts';
import { compareDocumentsAgainstScholarship } from '../src/lib/documentComparison.ts';
import {
  analyzeDocumentWithGemini,
  answerDocumentQuestion,
  DocumentProcessingError,
  extractRealDocumentText,
  maskSensitiveNumbers,
  validateDocumentBinary,
} from '../src/server/documentProcessor.ts';
import {
  deletePrivateDocument,
  readPrivateDocument,
  savePrivateDocument,
} from '../src/server/privateVault.ts';
import type { DocumentAnalysis, DocumentRecord, Scholarship, StudentProfile } from '../src/types/database.ts';

async function buildDigitalPdf(pagesLines: string[][]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const lines of pagesLines) {
    const page = pdfDoc.addPage([595, 842]);
    let y = 780;
    for (const line of lines) {
      page.drawText(line, { x: 50, y, size: 12, font });
      y -= 22;
    }
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildValidTestPng(width = 64, height = 32): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const rawRows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width, 255);
    row[0] = 0;
    rawRows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rawRows));
  return Buffer.concat([
    sig,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const TEST_PROFILE: StudentProfile = {
  uid: 'student-a',
  fullName: 'Aarav Sharma',
  email: 'aarav@example.com',
  state: 'West Bengal',
  district: 'Kolkata',
  category: 'General',
  educationLevel: 'Undergraduate (UG)',
  courseSpecialization: 'B.Tech Computer Science',
  previousMarksPercent: 86,
  familyAnnualIncomeInr: 180000,
  onboardingCompleted: true,
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',
};

async function runTests() {
  const svmcm = VERIFIED_INDIAN_SCHOLARSHIPS.find((s) => s.id === 'wb-svmcm-scholarship')!;
  assert.ok(svmcm, 'SVMCM verified scheme must exist');

  // 0. Privacy masking unit check
  assert.equal(
    maskSensitiveNumbers('Aadhaar: 1234 5678 9012'),
    'Aadhaar: XXXX-XXXX-9012',
    '12-digit Aadhaar must be masked'
  );

  // 1. Multi-page Digital PDF Income Certificate
  const incomePdf = await buildDigitalPdf([
    [
      'GOVERNMENT OF WEST BENGAL',
      'OFFICE OF THE TAHSILDAR / BDO, KOLKATA',
      'ANNUAL FAMILY INCOME CERTIFICATE',
      'Certificate Number: WB/INC/2026/44129',
      'Issue Date: 15-10-2026',
      'Valid Until: 31-03-2027',
    ],
    [
      'Certificate Holder Name: Aarav Sharma',
      'Guardian / Father Name: Rajesh Sharma',
      'Aadhaar Ref: 1234 5678 9012',
      'Annual Family Income: INR 1,80,000 (Rupees One Lakh Eighty Thousand Only)',
      'Issuing Authority: Block Development Officer, South Kolkata',
    ],
  ]);

  const incomeMime = validateDocumentBinary(incomePdf, 'application/pdf', 'income_cert.pdf');
  assert.equal(incomeMime, 'application/pdf');
  const incomeExtracted = await extractRealDocumentText(incomePdf, incomeMime);
  assert.equal(incomeExtracted.pageCount, 2, 'Must detect 2 pages');
  assert.equal(incomeExtracted.extractionMethod, 'pdf-text');
  assert.ok(incomeExtracted.combinedText.includes('[Page 1]'));
  assert.ok(incomeExtracted.combinedText.includes('[Page 2]'));
  assert.ok(!incomeExtracted.combinedText.includes('1234 5678 9012'), 'Aadhaar must be masked in extracted text');
  assert.ok(incomeExtracted.combinedText.includes('XXXX-XXXX-9012'));

  // 2. Scanned/Image-Only PDF + Real PNG Image OCR
  const scannedPdf = await buildDigitalPdf([[]]);
  const scannedExtracted = await extractRealDocumentText(scannedPdf, 'application/pdf');
  assert.equal(scannedExtracted.extractionMethod, 'gemini-multimodal-ocr');

  const pngBuffer = buildValidTestPng();
  const pngMime = validateDocumentBinary(pngBuffer, 'image/png', 'scan_doc.png');
  assert.equal(pngMime, 'image/png');
  const pngExtracted = await extractRealDocumentText(pngBuffer, pngMime);
  assert.equal(pngExtracted.extractionMethod, 'tesseract-ocr+gemini-vision');
  assert.equal(typeof pngExtracted.ocrConfidence, 'number');

  // 3. Digital PDF Academic Marksheet
  const marksheetPdf = await buildDigitalPdf([
    [
      'JADAVPUR UNIVERSITY - ACADEMIC MARKSHEET',
      'Student Name: Aarav Sharma',
      'Course: B.Tech Computer Science',
      'Semester: Semester 2 | Academic Year: 2025-26',
      'Subjects: Mathematics (88/100), Data Structures (86/100), Physics (84/100)',
      'Total Marks: 500 | Obtained Marks: 430 | Percentage: 86%',
    ],
  ]);
  const marksheetExtracted = await extractRealDocumentText(marksheetPdf, 'application/pdf');
  assert.equal(marksheetExtracted.extractionMethod, 'pdf-text');
  assert.ok(marksheetExtracted.combinedText.includes('430'));

  // 4. Digital PDF Domicile Certificate
  const domicilePdf = await buildDigitalPdf([
    [
      'GOVERNMENT OF WEST BENGAL - DOMICILE / RESIDENCE CERTIFICATE',
      'Student Name: Aarav Sharma',
      'State: West Bengal',
      'District: Kolkata',
      'Certificate Number: WB/DOM/2026/9812',
      'Issue Date: 12-09-2026',
      'Issuing Authority: Sub-Divisional Officer, Kolkata',
    ],
  ]);
  const domicileExtracted = await extractRealDocumentText(domicilePdf, 'application/pdf');
  assert.equal(domicileExtracted.extractionMethod, 'pdf-text');
  assert.ok(domicileExtracted.combinedText.includes('West Bengal'));

  // 5. Unreadable / Corrupted / Unsupported / Oversized validation errors
  assert.throws(
    () => validateDocumentBinary(Buffer.from('not-a-pdf'), 'application/pdf', 'fake.pdf'),
    (err: unknown) => err instanceof DocumentProcessingError && err.code === 'CORRUPTED_DOCUMENT'
  );
  assert.throws(
    () => validateDocumentBinary(Buffer.from('hello world'), 'text/plain', 'notes.txt'),
    (err: unknown) => err instanceof DocumentProcessingError && err.code === 'INVALID_FORMAT'
  );
  assert.throws(
    () => validateDocumentBinary(Buffer.alloc(9 * 1024 * 1024), 'application/pdf', 'huge.pdf'),
    (err: unknown) => err instanceof DocumentProcessingError && err.code === 'FILE_TOO_LARGE'
  );
  await assert.rejects(
    () => extractRealDocumentText(Buffer.from('%PDF-1.4\ncorrupted-xref-body'), 'application/pdf'),
    (err: unknown) => err instanceof DocumentProcessingError && err.code === 'CORRUPTED_DOCUMENT'
  );

  // 6. Private Vault Owner Isolation (Student A vs Student B) & Secure Deletion
  const vaultMeta = await savePrivateDocument('student-a', 'doc-test-phase4', incomePdf, {
    fileName: 'income_cert.pdf',
    mimeType: 'application/pdf',
    fileSizeBytes: incomePdf.byteLength,
  });
  assert.equal(vaultMeta.storagePath, 'private-vault/users/student-a/doc-test-phase4');
  const readOwn = await readPrivateDocument('student-a', 'doc-test-phase4');
  assert.ok(readOwn && readOwn.buffer.byteLength === incomePdf.byteLength);
  const readCrossTenant = await readPrivateDocument('student-b', 'doc-test-phase4');
  assert.equal(readCrossTenant, null, 'Student B must NEVER access Student A private document');
  const removed = await deletePrivateDocument('student-a', 'doc-test-phase4');
  assert.equal(removed, true);
  assert.equal(await readPrivateDocument('student-a', 'doc-test-phase4'), null);

  // 7. Live Gemini Extraction & Q&A when GEMINI_API_KEY is available
  const hasRealGeminiKey =
    Boolean(process.env.GEMINI_API_KEY) && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY';

  let incomeAnalysisRecord: DocumentAnalysis;
  if (hasRealGeminiKey) {
    const geminiIncomeRes = await analyzeDocumentWithGemini({
      buffer: incomePdf,
      rawExtraction: incomeExtracted,
      declaredCategory: 'Income Certificate',
      fileName: 'income_cert.pdf',
      studentProfile: TEST_PROFILE as unknown as Record<string, unknown>,
      selectedScholarship: svmcm as unknown as Record<string, unknown>,
    });

    assert.ok(geminiIncomeRes.analysis.extractedFields.length > 0, 'Must extract structured fields');
    assert.ok(
      geminiIncomeRes.analysis.extractedFields.every((f) => !f.value.includes('1234 5678 9012')),
      'Gemini extracted fields must not expose raw Aadhaar'
    );
    assert.ok(geminiIncomeRes.disclaimer.toLowerCase().includes('does not'));

    const qaAnswer = await answerDocumentQuestion({
      question: 'What is the annual family income extracted on this certificate and does it fit the ₹2,50,000 cap?',
      documentMeta: { fileName: 'income_cert.pdf', documentType: 'Income Certificate' },
      storedAnalysis: geminiIncomeRes.analysis as unknown as Record<string, unknown>,
      scholarshipContext: svmcm as unknown as Record<string, unknown>,
    });
    assert.ok(qaAnswer.includes('1,80,000') || qaAnswer.includes('180,000') || qaAnswer.includes('180000'));

    const geminiMarksheetRes = await analyzeDocumentWithGemini({
      buffer: marksheetPdf,
      rawExtraction: marksheetExtracted,
      declaredCategory: 'Academic Marksheet',
      fileName: 'marksheet.pdf',
      studentProfile: TEST_PROFILE as unknown as Record<string, unknown>,
      selectedScholarship: svmcm as unknown as Record<string, unknown>,
    });
    assert.ok(geminiMarksheetRes.analysis.detectedType.toLowerCase().includes('marksheet'));

    const geminiDomicileRes = await analyzeDocumentWithGemini({
      buffer: domicilePdf,
      rawExtraction: domicileExtracted,
      declaredCategory: 'Domicile Certificate',
      fileName: 'domicile.pdf',
      studentProfile: TEST_PROFILE as unknown as Record<string, unknown>,
      selectedScholarship: svmcm as unknown as Record<string, unknown>,
    });
    assert.ok(geminiDomicileRes.analysis.detectedType.toLowerCase().includes('domicile'));

    incomeAnalysisRecord = {
      id: 'ana-test-1',
      userId: 'student-a',
      documentId: 'doc-inc-1',
      detectedType: geminiIncomeRes.analysis.detectedType,
      readabilityStatus: geminiIncomeRes.analysis.readabilityStatus,
      extractionMethod: incomeExtracted.extractionMethod,
      pageCount: incomeExtracted.pageCount,
      rawTextPreview: geminiIncomeRes.rawTextPreview,
      issuingAuthority: geminiIncomeRes.analysis.issuingAuthority,
      validityNotes: geminiIncomeRes.analysis.validityNotes,
      expiryWarning: geminiIncomeRes.analysis.expiryWarning,
      overallConfidence: geminiIncomeRes.analysis.overallConfidence,
      extractedFields: geminiIncomeRes.analysis.extractedFields,
      missingFields: geminiIncomeRes.analysis.missingFields,
      unreadableFields: geminiIncomeRes.analysis.unreadableFields,
      profileMismatches: geminiIncomeRes.analysis.profileMismatches,
      manualVerificationItems: geminiIncomeRes.analysis.manualVerificationItems,
      issuesFound: geminiIncomeRes.analysis.issuesFound,
      recommendations: geminiIncomeRes.analysis.recommendations,
      readinessVerdict: geminiIncomeRes.analysis.readinessVerdict,
      disclaimer: geminiIncomeRes.disclaimer,
      createdAt: '2026-11-13T00:00:00.000Z',
    };
    console.log('Live Gemini extraction & Document Q&A verified against real PDF documents.');
  } else {
    console.log(
      'NOTE: Standalone CLI shell does not receive injected runtime GEMINI_API_KEY (injected into Express server.ts process); skipping direct CLI Gemini call and proceeding to scholarship comparison checks.'
    );
    incomeAnalysisRecord = {
      id: 'ana-test-1',
      userId: 'student-a',
      documentId: 'doc-inc-1',
      detectedType: 'Income Certificate',
      readabilityStatus: 'Readable',
      extractionMethod: incomeExtracted.extractionMethod,
      pageCount: incomeExtracted.pageCount,
      rawTextPreview: incomeExtracted.combinedText.slice(0, 1200),
      issuingAuthority: 'Block Development Officer, South Kolkata',
      validityNotes: 'Valid Until 31-03-2027',
      overallConfidence: 'High',
      extractedFields: [
        {
          fieldName: 'Annual Family Income',
          value: 'INR 1,80,000',
          confidence: 'High',
          status: 'Extracted',
          pageNumber: 2,
        },
      ],
      readinessVerdict: 'Ready',
      createdAt: '2026-11-13T00:00:00.000Z',
    };
  }

  // 8. Scholarship Requirement Comparison checks
  const docs: DocumentRecord[] = [
    {
      id: 'doc-inc-1',
      userId: 'student-a',
      documentType: 'Income Certificate',
      fileName: 'income_cert.pdf',
      mimeType: 'application/pdf',
      storagePath: 'private-vault/users/student-a/doc-inc-1',
      verificationStatus: 'Analyzed',
      processingStatus: 'Completed',
      createdAt: '2026-11-13T00:00:00.000Z',
      updatedAt: '2026-11-13T00:00:00.000Z',
    },
  ];
  const compReport = compareDocumentsAgainstScholarship(svmcm, docs, [incomeAnalysisRecord], TEST_PROFILE);
  assert.equal(compReport.hasPublishedRequirements, true);
  assert.ok(compReport.totalRequired === (svmcm.requiredDocuments?.length ?? 0));
  assert.ok(compReport.missingCount >= 3, 'Unuploaded required docs must be flagged Missing');

  // Unverified / no-checklist scholarship limitation test
  const unverifiedNoChecklist: Scholarship = {
    ...svmcm,
    id: 'unverified-no-docs',
    verificationStatus: 'Pending verification',
    requiredDocuments: [],
  };
  const limReport = compareDocumentsAgainstScholarship(
    unverifiedNoChecklist,
    docs,
    [incomeAnalysisRecord],
    TEST_PROFILE
  );
  assert.equal(limReport.hasPublishedRequirements, false);
  assert.equal(limReport.isScholarshipVerified, false);
  assert.ok(limReport.limitationNotice && limReport.limitationNotice.length > 20);

  console.log('Phase 4 Document Intelligence end-to-end verification PASSED.');
}

runTests().catch((err) => {
  console.error('Phase 4 verification failed:', err);
  process.exit(1);
});
