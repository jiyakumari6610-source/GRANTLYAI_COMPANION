import 'dotenv/config';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../src/data/verifiedScholarships.ts';
import { compareDocumentsAgainstScholarship } from '../src/lib/documentComparison.ts';
import {
  buildMarksheetExtractedFields,
  calculateMarksheetAggregates,
  recalculateMarksheetWithUserConfirmation,
} from '../src/lib/marksheetCalculator.ts';
import {
  analyzeDocumentWithGemini,
  extractRealDocumentText,
} from '../src/server/documentProcessor.ts';
import type { DocumentAnalysis, DocumentRecord, Scholarship, StudentProfile } from '../src/types/database.ts';

async function buildCbseStyleMarksheetPdf(): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([595, 842]);

  const lines = [
    'CENTRAL BOARD OF SECONDARY EDUCATION',
    'MARKS STATEMENT CUM CERTIFICATE',
    'SECONDARY SCHOOL EXAMINATION, 2024 (CLASS X)',
    'Candidate Name: TEST STUDENT | Roll No: 1234567',
    'SUB CODE | SUBJECT | THEORY | I.A. | TOTAL | MAX MARKS | GRADE',
    '184 | ENGLISH LNG & LIT. | 076 | 020 | 096 | 100 | A1',
    '002 | HINDI COURSE-A | 079 | 020 | 099 | 100 | A1',
    '041 | MATHEMATICS STANDARD | 070 | 020 | 090 | 100 | A1',
    '086 | SCIENCE | 075 | 020 | 095 | 100 | A1',
    '087 | SOCIAL SCIENCE | 077 | 020 | 097 | 100 | A1',
    'ADDITIONAL SUBJECT',
    '402 | INFORMATION TECHNOLOGY | 045 | 050 | 095 | 100 | A1',
    'RESULT: PASS',
  ];

  let y = 780;
  for (const line of lines) {
    page.drawText(line, { x: 45, y, size: 11, font });
    y -= 24;
  }

  return Buffer.from(await pdfDoc.save());
}

function runTestsSyncAndAsync() {
  // 1. CBSE Class 10 5-main + 1-additional calculation (no printed overall total)
  const cbseResult = calculateMarksheetAggregates({
    isMarksheet: true,
    boardOrUniversity: 'Central Board of Secondary Education (CBSE)',
    examinationName: 'Secondary School Examination, 2024',
    examClassOrLevel: 'Class 10',
    printedOverallAggregateFound: false,
    printedOverallObtainedMarks: null,
    printedOverallMaxMarks: null,
    printedOverallPercentage: null,
    subjectSelectionCertainty: 'Confirmed',
    uncertaintyReasons: [],
    subjects: [
      {
        subjectCode: '184',
        subjectName: 'English Language & Literature',
        subjectCategory: 'main',
        theoryMarks: 76,
        internalOrPracticalMarks: 20,
        printedTotalMarks: 96,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
      {
        subjectCode: '002',
        subjectName: 'Hindi Course-A',
        subjectCategory: 'main',
        theoryMarks: 79,
        internalOrPracticalMarks: 20,
        printedTotalMarks: 99,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
      {
        subjectCode: '041',
        subjectName: 'Mathematics Standard',
        subjectCategory: 'main',
        theoryMarks: 70,
        internalOrPracticalMarks: 20,
        printedTotalMarks: 90,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
      {
        subjectCode: '086',
        subjectName: 'Science',
        subjectCategory: 'main',
        theoryMarks: 75,
        internalOrPracticalMarks: 20,
        printedTotalMarks: 95,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
      {
        subjectCode: '087',
        subjectName: 'Social Science',
        subjectCategory: 'main',
        theoryMarks: 77,
        internalOrPracticalMarks: 20,
        printedTotalMarks: 97,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
      {
        subjectCode: '402',
        subjectName: 'Information Technology',
        subjectCategory: 'additional',
        theoryMarks: 45,
        internalOrPracticalMarks: 50,
        printedTotalMarks: 95,
        maxMarks: 100,
        grade: 'A1',
        pageNumber: 1,
      },
    ],
  });

  assert.equal(cbseResult.hasPrintedOverallAggregate, false);
  assert.equal(cbseResult.requiresUserConfirmation, false);
  assert.equal(cbseResult.confirmationStatus, 'Auto-Calculated');
  assert.ok(cbseResult.applicableRule.includes('CBSE Class 10'));
  assert.ok(cbseResult.mainAggregate, 'Main aggregate must be computed');
  assert.equal(cbseResult.mainAggregate.subjectCount, 5);
  assert.equal(cbseResult.mainAggregate.maximumMarks, 500);
  assert.equal(cbseResult.mainAggregate.obtainedMarks, 477);
  assert.equal(cbseResult.mainAggregate.percentage, 95.4);
  assert.equal(cbseResult.mainAggregate.sourceType, 'ai-calculated');

  assert.ok(
    cbseResult.aggregateIncludingAdditional,
    'Aggregate including additional subjects must be stored separately'
  );
  assert.equal(cbseResult.aggregateIncludingAdditional.subjectCount, 6);
  assert.equal(cbseResult.aggregateIncludingAdditional.maximumMarks, 600);
  assert.equal(cbseResult.aggregateIncludingAdditional.obtainedMarks, 572);
  assert.equal(cbseResult.aggregateIncludingAdditional.percentage, 95.33);
  assert.equal(cbseResult.aggregateIncludingAdditional.sourceType, 'ai-calculated');

  const extractedFields = buildMarksheetExtractedFields(cbseResult);
  const maxField = extractedFields.find((f) => f.fieldName.includes('Maximum Marks'));
  const obtField = extractedFields.find((f) => f.fieldName.includes('Obtained Marks'));
  const pctField = extractedFields.find((f) => f.fieldName.includes('Percentage'));
  const incField = extractedFields.find((f) => f.fieldName.includes('Additional'));
  assert.ok(maxField?.value.includes('500') && maxField.value.includes('AI-Calculated'));
  assert.ok(obtField?.value.includes('477') && obtField.value.includes('AI-Calculated'));
  assert.ok(pctField?.value.includes('95.4%') && pctField.value.includes('AI-Calculated'));
  assert.ok(incField?.value.includes('572 / 600') && incField.value.includes('AI-Calculated'));

  // 2. Subject-wise total confusion guardrail + missing printed total calculation from components
  const subjectConfusionRes = calculateMarksheetAggregates({
    isMarksheet: true,
    boardOrUniversity: 'CBSE',
    examinationName: 'Secondary School Examination',
    examClassOrLevel: 'Class 10',
    printedOverallAggregateFound: true,
    printedOverallMaxMarks: 100, // erroneously copied from single subject maxMarks!
    printedOverallObtainedMarks: 95, // erroneously copied from single subject marks!
    printedOverallPercentage: null,
    subjectSelectionCertainty: 'Confirmed',
    subjects: [
      { subjectName: 'Sub 1', subjectCategory: 'main', theoryMarks: 70, internalOrPracticalMarks: 20, printedTotalMarks: null, maxMarks: 100 },
      { subjectName: 'Sub 2', subjectCategory: 'main', theoryMarks: 65, internalOrPracticalMarks: 20, printedTotalMarks: 85, maxMarks: 100 },
      { subjectName: 'Sub 3', subjectCategory: 'main', theoryMarks: 60, internalOrPracticalMarks: 20, printedTotalMarks: 80, maxMarks: 100 },
      { subjectName: 'Sub 4', subjectCategory: 'main', theoryMarks: 75, internalOrPracticalMarks: 20, printedTotalMarks: 95, maxMarks: 100 },
      { subjectName: 'Sub 5', subjectCategory: 'main', theoryMarks: 55, internalOrPracticalMarks: 20, printedTotalMarks: 75, maxMarks: 100 },
    ],
  });

  assert.equal(subjectConfusionRes.hasPrintedOverallAggregate, false, 'Single-subject 100/95 must NOT be treated as printed overall aggregate');
  assert.equal(subjectConfusionRes.subjects[0].calculatedTotalMarks, 90);
  assert.equal(subjectConfusionRes.subjects[0].effectiveTotalMarks, 90);
  assert.equal(subjectConfusionRes.subjects[0].totalSource, 'ai-calculated');
  assert.equal(subjectConfusionRes.mainAggregate?.obtainedMarks, 425);
  assert.equal(subjectConfusionRes.mainAggregate?.maximumMarks, 500);
  assert.equal(subjectConfusionRes.mainAggregate?.percentage, 85);

  // 3. Uncertain subject selection triggers confirmation rather than silent guessing
  const uncertainRes = calculateMarksheetAggregates({
    isMarksheet: true,
    boardOrUniversity: 'CBSE',
    examinationName: 'Secondary School Examination',
    examClassOrLevel: 'Class 10',
    printedOverallAggregateFound: false,
    subjectSelectionCertainty: 'Needs Confirmation',
    subjects: [
      { subjectName: 'English', subjectCategory: 'main', theoryMarks: 70, internalOrPracticalMarks: 20, printedTotalMarks: 90, maxMarks: 100 },
      { subjectName: 'Hindi', subjectCategory: 'main', theoryMarks: 70, internalOrPracticalMarks: 18, printedTotalMarks: 88, maxMarks: 100 },
      { subjectName: 'Math', subjectCategory: 'main', theoryMarks: 72, internalOrPracticalMarks: 20, printedTotalMarks: 92, maxMarks: 100 },
      { subjectName: 'Science', subjectCategory: 'main', theoryMarks: 68, internalOrPracticalMarks: 19, printedTotalMarks: 87, maxMarks: 100 },
      { subjectName: 'Social Science', subjectCategory: 'uncertain', theoryMarks: 74, internalOrPracticalMarks: 19, printedTotalMarks: 93, maxMarks: 100 },
      { subjectName: 'Sanskrit', subjectCategory: 'uncertain', theoryMarks: 75, internalOrPracticalMarks: 20, printedTotalMarks: 95, maxMarks: 100 },
    ],
  });

  assert.equal(uncertainRes.requiresUserConfirmation, true);
  assert.equal(uncertainRes.confirmationStatus, 'Needs Confirmation');
  assert.ok(uncertainRes.confirmationReasons.length > 0);

  // Student confirms 5 main + 1 additional
  const confirmedRes = recalculateMarksheetWithUserConfirmation(uncertainRes, [
    { subjectName: 'English', subjectCategory: 'main', maxMarks: 100 },
    { subjectName: 'Hindi', subjectCategory: 'main', maxMarks: 100 },
    { subjectName: 'Math', subjectCategory: 'main', maxMarks: 100 },
    { subjectName: 'Science', subjectCategory: 'main', maxMarks: 100 },
    { subjectName: 'Social Science', subjectCategory: 'main', maxMarks: 100 },
    { subjectName: 'Sanskrit', subjectCategory: 'additional', maxMarks: 100 },
  ]);
  assert.equal(confirmedRes.requiresUserConfirmation, false);
  assert.equal(confirmedRes.confirmationStatus, 'Confirmed by Student');
  assert.equal(confirmedRes.mainAggregate?.obtainedMarks, 450);
  assert.equal(confirmedRes.mainAggregate?.maximumMarks, 500);
  assert.equal(confirmedRes.mainAggregate?.percentage, 90);
  assert.equal(confirmedRes.aggregateIncludingAdditional?.obtainedMarks, 545);
  assert.equal(confirmedRes.aggregateIncludingAdditional?.maximumMarks, 600);

  // 4. Scholarship Document Comparison integration
  const sampleScholarship: Scholarship = {
    ...VERIFIED_INDIAN_SCHOLARSHIPS[0],
    minMarksPercent: 92,
    requiredDocuments: ['Previous Academic Marksheet'],
  };
  const docRec: DocumentRecord = {
    id: 'doc-ms-1',
    userId: 'stu-1',
    documentType: 'Academic Marksheet',
    fileName: 'cbse_x_marksheet.pdf',
    storagePath: 'private-vault/users/stu-1/doc-ms-1',
    verificationStatus: 'Needs Attention',
    processingStatus: 'Needs Review',
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
  };
  const unconfirmedAna: DocumentAnalysis = {
    id: 'ana-1',
    userId: 'stu-1',
    documentId: 'doc-ms-1',
    detectedType: 'Academic Marksheet',
    readabilityStatus: 'Readable',
    overallConfidence: 'High',
    marksheetSummary: uncertainRes,
    readinessVerdict: 'Needs Clarification',
    createdAt: '2026-11-13T00:00:00.000Z',
  };
  const unconfirmedComp = compareDocumentsAgainstScholarship(
    sampleScholarship,
    [docRec],
    [unconfirmedAna],
    null as unknown as StudentProfile
  );
  assert.equal(unconfirmedComp.items[0].status, 'Needs Review');
  assert.ok(
    unconfirmedComp.items[0].notes.some((n) => n.toLowerCase().includes('confirmation'))
  );

  const lowMarksSummary = calculateMarksheetAggregates({
    isMarksheet: true,
    boardOrUniversity: 'CBSE',
    examinationName: 'Secondary School Examination',
    examClassOrLevel: 'Class 10',
    printedOverallAggregateFound: false,
    subjectSelectionCertainty: 'Confirmed',
    subjects: [
      { subjectName: 'S1', subjectCategory: 'main', printedTotalMarks: 80, maxMarks: 100 },
      { subjectName: 'S2', subjectCategory: 'main', printedTotalMarks: 80, maxMarks: 100 },
      { subjectName: 'S3', subjectCategory: 'main', printedTotalMarks: 80, maxMarks: 100 },
      { subjectName: 'S4', subjectCategory: 'main', printedTotalMarks: 80, maxMarks: 100 },
      { subjectName: 'S5', subjectCategory: 'main', printedTotalMarks: 80, maxMarks: 100 },
    ],
  });
  const readyDoc: DocumentRecord = {
    ...docRec,
    verificationStatus: 'Analyzed',
    processingStatus: 'Completed',
  };
  const lowMarksAna: DocumentAnalysis = {
    ...unconfirmedAna,
    marksheetSummary: lowMarksSummary,
    readinessVerdict: 'Ready',
  };
  const lowMarksComp = compareDocumentsAgainstScholarship(
    sampleScholarship,
    [readyDoc],
    [lowMarksAna],
    null as unknown as StudentProfile
  );
  assert.equal(lowMarksComp.items[0].status, 'Needs Review');
  assert.ok(
    lowMarksComp.items[0].notes.some((n) => n.includes('80%') && n.includes('92%'))
  );
}

async function runAsyncPdfChecks() {
  runTestsSyncAndAsync();

  const pdfBuffer = await buildCbseStyleMarksheetPdf();
  const extracted = await extractRealDocumentText(pdfBuffer, 'application/pdf');
  assert.equal(extracted.extractionMethod, 'pdf-text');
  assert.ok(extracted.combinedText.includes('ADDITIONAL SUBJECT'));
  assert.ok(extracted.combinedText.includes('096'));

  const hasRealGeminiKey =
    Boolean(process.env.GEMINI_API_KEY) && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY';

  if (hasRealGeminiKey) {
    const res = await analyzeDocumentWithGemini({
      buffer: pdfBuffer,
      rawExtraction: extracted,
      declaredCategory: 'Academic Marksheet',
      fileName: 'cbse_x_marksheet.pdf',
      studentProfile: null,
      selectedScholarship: null,
    });
    assert.ok(res.analysis.marksheetSummary, 'marksheetSummary must be populated');
    assert.equal(res.analysis.marksheetSummary.mainAggregate?.maximumMarks, 500);
    assert.equal(res.analysis.marksheetSummary.mainAggregate?.obtainedMarks, 477);
    assert.equal(res.analysis.marksheetSummary.mainAggregate?.percentage, 95.4);
    assert.equal(res.analysis.marksheetSummary.mainAggregate?.sourceType, 'ai-calculated');
    assert.equal(res.analysis.marksheetSummary.aggregateIncludingAdditional?.obtainedMarks, 572);
    assert.equal(res.analysis.marksheetSummary.aggregateIncludingAdditional?.maximumMarks, 600);
    console.log('Live Gemini CBSE Class 10 Marksheet extraction + calculation verified.');
  } else {
    console.log(
      'NOTE: Standalone CLI shell does not receive injected runtime GEMINI_API_KEY; deterministic calculation, subject separation, uncertainty confirmation, PDF text extraction, and scholarship comparison tests all PASSED.'
    );
  }

  console.log('Marksheet Document Intelligence test suite PASSED.');
}

runAsyncPdfChecks().catch((err) => {
  console.error('Marksheet verification failed:', err);
  process.exit(1);
});
