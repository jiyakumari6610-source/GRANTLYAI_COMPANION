import type {
  ExtractedDocumentField,
  MarksheetAggregateBreakdown,
  MarksheetConfirmationStatus,
  MarksheetExtractionSummary,
  MarksheetSubjectEntry,
  MarksheetSubjectRole,
  MarksheetValueSource,
} from '../types/database.ts';

export interface RawExtractedMarksheetSubject {
  subjectCode?: string | null;
  subjectName: string;
  subjectCategory?: MarksheetSubjectRole | string | null;
  theoryMarks?: number | null;
  internalOrPracticalMarks?: number | null;
  printedTotalMarks?: number | null;
  maxMarks?: number | null;
  grade?: string | null;
  resultStatus?: string | null;
  pageNumber?: number | null;
}

export interface RawExtractedMarksheetPayload {
  isMarksheet?: boolean;
  boardOrUniversity?: string | null;
  examinationName?: string | null;
  examClassOrLevel?: string | null;
  printedOverallAggregateFound?: boolean | null;
  printedOverallObtainedMarks?: number | null;
  printedOverallMaxMarks?: number | null;
  printedOverallPercentage?: number | null;
  subjectSelectionCertainty?: 'Confirmed' | 'Needs Confirmation' | string | null;
  uncertaintyReasons?: string[] | null;
  subjects?: RawExtractedMarksheetSubject[] | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toFiniteNumberOrNull(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const num = typeof val === 'number' ? val : Number(val);
  return Number.isFinite(num) && num >= 0 ? round2(num) : null;
}

function normalizeRole(role: unknown): MarksheetSubjectRole {
  const lower = String(role || '').trim().toLowerCase();
  if (lower === 'main' || lower === 'core' || lower === 'compulsory') return 'main';
  if (lower === 'additional' || lower === 'optional' || lower === 'extra') return 'additional';
  if (lower === 'excluded') return 'excluded';
  return 'uncertain';
}

export function detectAssessmentRule(
  boardOrUniversity: string,
  examinationName: string,
  examClassOrLevel: string
): {
  isCbseClass10: boolean;
  isCbseClass12: boolean;
  ruleName: string;
  ruleIsUncertain: boolean;
  ruleReason?: string;
} {
  const board = boardOrUniversity.trim();
  const exam = examinationName.trim();
  const level = examClassOrLevel.trim();
  const combined = `${board} ${exam} ${level}`;

  const isCbse = /\bcbse\b|central board of secondary education/i.test(combined);
  const explicitlyClass12 =
    /class\s*(?:xii|12|twelfth)\b|senior\s*(?:school|secondary)/i.test(combined);
  const explicitlyClass10 =
    !explicitlyClass12 &&
    (/class\s*(?:x|10|tenth)\b|secondary school examination/i.test(combined) ||
      level.toLowerCase() === 'class 10');

  if (isCbse && explicitlyClass10) {
    return {
      isCbseClass10: true,
      isCbseClass12: false,
      ruleName:
        'CBSE Class 10 Rule: 5-Subject Main Aggregate (Additional subjects excluded from main 5-subject aggregate)',
      ruleIsUncertain: false,
    };
  }

  if (isCbse && explicitlyClass12) {
    return {
      isCbseClass10: false,
      isCbseClass12: true,
      ruleName:
        'CBSE Class 12 Rule: 5-Subject Main Aggregate (Additional subjects tracked separately)',
      ruleIsUncertain: false,
    };
  }

  if (!board && !exam) {
    return {
      isCbseClass10: false,
      isCbseClass12: false,
      ruleName: 'Assessment Rule Unconfirmed (Board / Examination not clearly detected)',
      ruleIsUncertain: true,
      ruleReason:
        'Board or examination level could not be identified clearly; confirm which subjects belong to the main aggregate.',
    };
  }

  if (level.toLowerCase() === 'uncertain' || level.toLowerCase() === 'other') {
    return {
      isCbseClass10: false,
      isCbseClass12: false,
      ruleName: `${board || 'Board'} — Subject Selection Needs Confirmation`,
      ruleIsUncertain: true,
      ruleReason:
        'Applicable board/institution aggregate rule (e.g. Best-of-5 vs All Main Subjects) is uncertain; please confirm subject selection.',
    };
  }

  return {
    isCbseClass10: false,
    isCbseClass12: false,
    ruleName: `${board || exam || 'Academic'} Main Subjects Aggregate (Additional subjects tracked separately)`,
    ruleIsUncertain: false,
  };
}

function buildAggregate(
  label: string,
  subjects: MarksheetSubjectEntry[],
  sourceType: MarksheetValueSource
): { aggregate: MarksheetAggregateBreakdown | null; blockers: string[] } {
  if (subjects.length === 0) {
    return { aggregate: null, blockers: [`No subjects assigned to "${label}".`] };
  }

  const blockers: string[] = [];
  for (const subj of subjects) {
    if (subj.effectiveTotalMarks === null) {
      blockers.push(`Missing obtained marks for "${subj.subjectName}".`);
    }
    if (subj.maxMarks === null || subj.maxMarks <= 0) {
      blockers.push(`Missing maximum marks for "${subj.subjectName}".`);
    }
  }

  if (blockers.length > 0) {
    return { aggregate: null, blockers };
  }

  const obtainedMarks = round2(
    subjects.reduce((acc, s) => acc + (s.effectiveTotalMarks ?? 0), 0)
  );
  const maximumMarks = round2(
    subjects.reduce((acc, s) => acc + (s.maxMarks ?? 0), 0)
  );

  if (maximumMarks <= 0) {
    return { aggregate: null, blockers: ['Total maximum marks must be greater than zero.'] };
  }

  const percentage = round2((obtainedMarks / maximumMarks) * 100);

  return {
    aggregate: {
      label,
      subjectCount: subjects.length,
      obtainedMarks,
      maximumMarks,
      percentage,
      sourceType,
      includedSubjects: subjects.map((s) => s.subjectName),
    },
    blockers: [],
  };
}

export function calculateMarksheetAggregates(
  raw: RawExtractedMarksheetPayload,
  options?: { confirmedByUser?: boolean }
): MarksheetExtractionSummary {
  const boardOrUniversity = (raw.boardOrUniversity || '').trim() || 'Not Clearly Visible';
  const examinationName = (raw.examinationName || '').trim() || 'Academic Examination';
  const examClassOrLevel = (raw.examClassOrLevel || '').trim() || 'Uncertain';
  const confirmedByUser = Boolean(options?.confirmedByUser);

  const ruleInfo = detectAssessmentRule(boardOrUniversity, examinationName, examClassOrLevel);

  const rawSubjects = Array.isArray(raw.subjects) ? raw.subjects : [];
  const confirmationReasons: string[] = [];
  const calculationNotes: string[] = [];

  if (Array.isArray(raw.uncertaintyReasons)) {
    for (const reason of raw.uncertaintyReasons) {
      const cleaned = String(reason || '').trim();
      if (cleaned) confirmationReasons.push(cleaned);
    }
  }

  if (ruleInfo.ruleIsUncertain && !confirmedByUser && ruleInfo.ruleReason) {
    confirmationReasons.push(ruleInfo.ruleReason);
  }

  const subjects: MarksheetSubjectEntry[] = rawSubjects
    .filter((s) => s && String(s.subjectName || '').trim().length > 0)
    .map((s) => {
      const subjectName = String(s.subjectName).trim();
      const theoryMarks = toFiniteNumberOrNull(s.theoryMarks);
      const internalOrPracticalMarks = toFiniteNumberOrNull(s.internalOrPracticalMarks);
      const printedTotalMarks = toFiniteNumberOrNull(s.printedTotalMarks);
      const maxMarks = toFiniteNumberOrNull(s.maxMarks);

      const hasComponents = theoryMarks !== null || internalOrPracticalMarks !== null;
      const calculatedTotalMarks = hasComponents
        ? round2((theoryMarks ?? 0) + (internalOrPracticalMarks ?? 0))
        : printedTotalMarks;

      let hasArithmeticDiscrepancy = false;
      let discrepancyNote: string | undefined;

      if (
        printedTotalMarks !== null &&
        hasComponents &&
        calculatedTotalMarks !== null &&
        Math.abs(printedTotalMarks - calculatedTotalMarks) > 0.01
      ) {
        hasArithmeticDiscrepancy = true;
        discrepancyNote = `${subjectName}: Printed total (${printedTotalMarks}) differs from Theory (${theoryMarks ?? 0}) + Internal/Practical (${internalOrPracticalMarks ?? 0}) = ${calculatedTotalMarks}.`;
        calculationNotes.push(discrepancyNote);
        if (!confirmedByUser) {
          confirmationReasons.push(discrepancyNote);
        }
      }

      const effectiveTotalMarks = printedTotalMarks ?? calculatedTotalMarks;
      const totalSource: MarksheetValueSource =
        printedTotalMarks !== null && !hasArithmeticDiscrepancy
          ? 'document-extracted'
          : 'ai-calculated';

      if (maxMarks !== null && effectiveTotalMarks !== null && effectiveTotalMarks > maxMarks) {
        const msg = `${subjectName}: Effective marks (${effectiveTotalMarks}) exceed maximum marks (${maxMarks}).`;
        calculationNotes.push(msg);
        if (!confirmedByUser) confirmationReasons.push(msg);
      }

      return {
        ...(s.subjectCode ? { subjectCode: String(s.subjectCode).trim() } : {}),
        subjectName,
        subjectCategory: normalizeRole(s.subjectCategory),
        theoryMarks,
        internalOrPracticalMarks,
        printedTotalMarks,
        calculatedTotalMarks,
        effectiveTotalMarks,
        maxMarks,
        ...(s.grade ? { grade: String(s.grade).trim() } : {}),
        ...(s.resultStatus ? { resultStatus: String(s.resultStatus).trim() } : {}),
        totalSource,
        ...(hasArithmeticDiscrepancy ? { hasArithmeticDiscrepancy, discrepancyNote } : {}),
        pageNumber:
          typeof s.pageNumber === 'number' && s.pageNumber >= 1 ? s.pageNumber : 1,
      };
    });

  // Guardrail 8: Never confuse a subject-wise total with overall total
  const rawPrintedMax = toFiniteNumberOrNull(raw.printedOverallMaxMarks);
  const rawPrintedObtained = toFiniteNumberOrNull(raw.printedOverallObtainedMarks);
  const rawPrintedPercent = toFiniteNumberOrNull(raw.printedOverallPercentage);

  const highestSingleSubjectMax = Math.max(0, ...subjects.map((s) => s.maxMarks ?? 0));
  const highestSingleSubjectObtained = Math.max(
    0,
    ...subjects.map((s) => s.effectiveTotalMarks ?? 0)
  );

  let hasPrintedOverallAggregate = Boolean(raw.printedOverallAggregateFound);
  let printedOverallMaxMarks = rawPrintedMax;
  let printedOverallObtainedMarks = rawPrintedObtained;
  let printedOverallPercentage = rawPrintedPercent;

  if (subjects.length > 1) {
    if (printedOverallMaxMarks !== null && printedOverallMaxMarks <= highestSingleSubjectMax) {
      calculationNotes.push(
        `Ignored printed overall max marks (${printedOverallMaxMarks}) because it matches/falls below a single subject's maximum marks (${highestSingleSubjectMax}) and is not a multi-subject overall total.`
      );
      printedOverallMaxMarks = null;
      hasPrintedOverallAggregate = false;
    }
    if (
      printedOverallObtainedMarks !== null &&
      printedOverallObtainedMarks <= highestSingleSubjectObtained
    ) {
      calculationNotes.push(
        `Ignored printed overall obtained marks (${printedOverallObtainedMarks}) because it is not larger than a single subject's marks (${highestSingleSubjectObtained}).`
      );
      printedOverallObtainedMarks = null;
      hasPrintedOverallAggregate = false;
    }
  }

  if (
    printedOverallObtainedMarks === null &&
    printedOverallMaxMarks === null &&
    printedOverallPercentage === null
  ) {
    hasPrintedOverallAggregate = false;
  }

  // Classify subjects
  const mainSubjects = subjects.filter((s) => s.subjectCategory === 'main');
  const additionalSubjects = subjects.filter((s) => s.subjectCategory === 'additional');
  const uncertainSubjects = subjects.filter((s) => s.subjectCategory === 'uncertain');

  if (subjects.length === 0) {
    confirmationReasons.push('No subject rows could be extracted from the marksheet.');
  }

  if (uncertainSubjects.length > 0 && !confirmedByUser) {
    confirmationReasons.push(
      `Role (Main vs Additional) is uncertain for: ${uncertainSubjects.map((s) => s.subjectName).join(', ')}. Please confirm subject classification.`
    );
  }

  if (
    raw.subjectSelectionCertainty === 'Needs Confirmation' &&
    !confirmedByUser &&
    confirmationReasons.length === 0
  ) {
    confirmationReasons.push(
      'Subject selection or additional subject grouping on the marksheet needs student confirmation.'
    );
  }

  // CBSE Class 10 specific 5-subject rule checks
  if (ruleInfo.isCbseClass10 && !confirmedByUser) {
    if (mainSubjects.length > 5) {
      confirmationReasons.push(
        `CBSE Class 10 uses 5 main subjects, but ${mainSubjects.length} subjects were detected as main without a clear additional subject marker. Please confirm which 5 subjects form the main aggregate.`
      );
    } else if (mainSubjects.length > 0 && mainSubjects.length < 5) {
      confirmationReasons.push(
        `CBSE Class 10 normally includes 5 main subjects, but only ${mainSubjects.length} main subject(s) were detected. Please confirm subject roles before finalizing.`
      );
    }
  }

  // Determine source provenance for calculated aggregates
  const mainLabel = ruleInfo.isCbseClass10 || ruleInfo.isCbseClass12
    ? 'Main 5-Subject Aggregate'
    : 'Main Subjects Aggregate';

  const preliminaryMain = buildAggregate(mainLabel, mainSubjects, 'ai-calculated');
  for (const b of preliminaryMain.blockers) {
    if (!confirmedByUser || preliminaryMain.aggregate === null) {
      confirmationReasons.push(b);
    }
  }

  let mainAggregate = preliminaryMain.aggregate;
  if (mainAggregate) {
    const matchesPrintedOverall =
      hasPrintedOverallAggregate &&
      printedOverallObtainedMarks !== null &&
      printedOverallMaxMarks !== null &&
      Math.abs(printedOverallObtainedMarks - mainAggregate.obtainedMarks) <= 0.01 &&
      Math.abs(printedOverallMaxMarks - mainAggregate.maximumMarks) <= 0.01;

    mainAggregate = {
      ...mainAggregate,
      sourceType: matchesPrintedOverall ? 'document-extracted' : 'ai-calculated',
    };

    if (!hasPrintedOverallAggregate) {
      calculationNotes.push(
        `Overall aggregate marks and percentage were not printed on the marksheet; ${mainAggregate.label} (${mainAggregate.obtainedMarks}/${mainAggregate.maximumMarks} = ${mainAggregate.percentage}%) is AI-calculated from extracted subject totals.`
      );
    } else if (!matchesPrintedOverall && printedOverallObtainedMarks !== null && printedOverallMaxMarks !== null) {
      const note = `Document printed overall (${printedOverallObtainedMarks}/${printedOverallMaxMarks}) differs from computed ${mainAggregate.label} (${mainAggregate.obtainedMarks}/${mainAggregate.maximumMarks}).`;
      calculationNotes.push(note);
      if (!confirmedByUser) confirmationReasons.push(note);
    }
  }

  // Aggregate including additional subjects (always compute separately when additional subjects exist)
  let aggregateIncludingAdditional: MarksheetAggregateBreakdown | null = null;
  if (additionalSubjects.length > 0) {
    const combinedSubjects = [...mainSubjects, ...additionalSubjects];
    const combinedRes = buildAggregate(
      'Aggregate Including Additional Subject(s)',
      combinedSubjects,
      'ai-calculated'
    );
    if (combinedRes.aggregate) {
      const matchesPrintedAll =
        hasPrintedOverallAggregate &&
        printedOverallObtainedMarks !== null &&
        printedOverallMaxMarks !== null &&
        Math.abs(printedOverallObtainedMarks - combinedRes.aggregate.obtainedMarks) <= 0.01 &&
        Math.abs(printedOverallMaxMarks - combinedRes.aggregate.maximumMarks) <= 0.01;
      aggregateIncludingAdditional = {
        ...combinedRes.aggregate,
        sourceType: matchesPrintedAll ? 'document-extracted' : 'ai-calculated',
      };
      calculationNotes.push(
        `Additional subject(s) (${additionalSubjects.map((s) => s.subjectName).join(', ')}) are excluded from the main aggregate${ruleInfo.isCbseClass10 ? ' per CBSE Class 10 rules' : ''} and stored separately as "${aggregateIncludingAdditional.label}" (${aggregateIncludingAdditional.obtainedMarks}/${aggregateIncludingAdditional.maximumMarks} = ${aggregateIncludingAdditional.percentage}%).`
      );
    } else {
      for (const b of combinedRes.blockers) {
        calculationNotes.push(`Additional-inclusive aggregate skipped: ${b}`);
      }
    }
  }

  const dedupedReasons = Array.from(new Set(confirmationReasons));
  const requiresUserConfirmation =
    dedupedReasons.length > 0 && (!confirmedByUser || mainAggregate === null);

  const confirmationStatus: MarksheetConfirmationStatus = requiresUserConfirmation
    ? 'Needs Confirmation'
    : confirmedByUser
      ? 'Confirmed by Student'
      : 'Auto-Calculated';

  return {
    boardOrUniversity,
    examinationName,
    examClassOrLevel,
    applicableRule: ruleInfo.ruleName,
    hasPrintedOverallAggregate,
    printedOverallObtainedMarks,
    printedOverallMaxMarks,
    printedOverallPercentage,
    subjects,
    mainAggregate,
    aggregateIncludingAdditional,
    requiresUserConfirmation,
    confirmationStatus,
    confirmationReasons: dedupedReasons,
    calculationNotes: Array.from(new Set(calculationNotes)),
  };
}

export function recalculateMarksheetWithUserConfirmation(
  existing: MarksheetExtractionSummary,
  updatedSubjects: Array<{
    subjectName: string;
    subjectCategory: MarksheetSubjectRole;
    maxMarks: number | null;
    theoryMarks?: number | null;
    internalOrPracticalMarks?: number | null;
    printedTotalMarks?: number | null;
  }>,
  overrideRuleText?: string
): MarksheetExtractionSummary {
  const recalculated = calculateMarksheetAggregates(
    {
      isMarksheet: true,
      boardOrUniversity: existing.boardOrUniversity,
      examinationName: existing.examinationName,
      examClassOrLevel: existing.examClassOrLevel,
      printedOverallAggregateFound: existing.hasPrintedOverallAggregate,
      printedOverallObtainedMarks: existing.printedOverallObtainedMarks ?? null,
      printedOverallMaxMarks: existing.printedOverallMaxMarks ?? null,
      printedOverallPercentage: existing.printedOverallPercentage ?? null,
      subjectSelectionCertainty: 'Confirmed',
      uncertaintyReasons: [],
      subjects: updatedSubjects.map((u, idx) => {
        const orig = existing.subjects[idx];
        return {
          subjectCode: orig?.subjectCode ?? null,
          subjectName: u.subjectName,
          subjectCategory: u.subjectCategory,
          theoryMarks: u.theoryMarks !== undefined ? u.theoryMarks : orig?.theoryMarks ?? null,
          internalOrPracticalMarks:
            u.internalOrPracticalMarks !== undefined
              ? u.internalOrPracticalMarks
              : orig?.internalOrPracticalMarks ?? null,
          printedTotalMarks:
            u.printedTotalMarks !== undefined
              ? u.printedTotalMarks
              : orig?.printedTotalMarks ?? null,
          maxMarks: u.maxMarks,
          grade: orig?.grade ?? null,
          resultStatus: orig?.resultStatus ?? null,
          pageNumber: orig?.pageNumber ?? 1,
        };
      }),
    },
    { confirmedByUser: true }
  );

  if (overrideRuleText && overrideRuleText.trim()) {
    recalculated.applicableRule = overrideRuleText.trim();
  }

  return recalculated;
}

export function buildMarksheetExtractedFields(
  summary: MarksheetExtractionSummary
): ExtractedDocumentField[] {
  const fields: ExtractedDocumentField[] = [];
  const firstPage = summary.subjects[0]?.pageNumber ?? 1;

  fields.push({
    fieldName: 'Board / University',
    value: summary.boardOrUniversity,
    confidence: summary.boardOrUniversity === 'Not Clearly Visible' ? 'Low' : 'High',
    status: summary.boardOrUniversity === 'Not Clearly Visible' ? 'Unreadable' : 'Extracted',
    pageNumber: firstPage,
  });

  fields.push({
    fieldName: 'Examination & Level',
    value: `${summary.examinationName} (${summary.examClassOrLevel})`,
    confidence: summary.examClassOrLevel === 'Uncertain' ? 'Medium' : 'High',
    status: 'Extracted',
    pageNumber: firstPage,
  });

  fields.push({
    fieldName: 'Applicable Assessment Rule',
    value: summary.applicableRule,
    confidence: summary.requiresUserConfirmation ? 'Medium' : 'High',
    status: 'Extracted',
    pageNumber: firstPage,
  });

  if (summary.mainAggregate) {
    const tag =
      summary.mainAggregate.sourceType === 'document-extracted'
        ? 'Document-Extracted'
        : 'AI-Calculated';

    fields.push({
      fieldName: `Overall Maximum Marks (${summary.mainAggregate.label})`,
      value: `${summary.mainAggregate.maximumMarks} (${tag})`,
      confidence: summary.requiresUserConfirmation ? 'Medium' : 'High',
      status: 'Extracted',
      pageNumber: firstPage,
    });

    fields.push({
      fieldName: `Overall Obtained Marks (${summary.mainAggregate.label})`,
      value: `${summary.mainAggregate.obtainedMarks} (${tag})`,
      confidence: summary.requiresUserConfirmation ? 'Medium' : 'High',
      status: 'Extracted',
      pageNumber: firstPage,
    });

    fields.push({
      fieldName: `Overall Percentage (${summary.mainAggregate.label})`,
      value: `${summary.mainAggregate.percentage}% (${tag})`,
      confidence: summary.requiresUserConfirmation ? 'Medium' : 'High',
      status: 'Extracted',
      pageNumber: firstPage,
    });
  } else {
    fields.push({
      fieldName: 'Overall Aggregate Marks & Percentage',
      value: 'Confirmation required before aggregate calculation',
      confidence: 'Low',
      status: 'Absent',
      pageNumber: firstPage,
    });
  }

  if (summary.aggregateIncludingAdditional) {
    const inc = summary.aggregateIncludingAdditional;
    const tag = inc.sourceType === 'document-extracted' ? 'Document-Extracted' : 'AI-Calculated';
    fields.push({
      fieldName: inc.label,
      value: `${inc.obtainedMarks} / ${inc.maximumMarks} (${inc.percentage}%) (${tag})`,
      confidence: summary.requiresUserConfirmation ? 'Medium' : 'High',
      status: 'Extracted',
      pageNumber: firstPage,
    });
  }

  fields.push({
    fieldName: 'Subject Selection Status',
    value: `${summary.confirmationStatus} · ${summary.subjects.filter((s) => s.subjectCategory === 'main').length} main, ${summary.subjects.filter((s) => s.subjectCategory === 'additional').length} additional`,
    confidence: summary.requiresUserConfirmation ? 'Medium' : 'High',
    status: 'Extracted',
    pageNumber: firstPage,
  });

  return fields;
}
