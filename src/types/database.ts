export type GenderOption = 'Female' | 'Male' | 'Non-Binary' | 'Prefer not to say';
export type CategoryOption = 'General' | 'OBC-NCL' | 'SC' | 'ST' | 'EWS' | 'Minority';
export type DisabilityOption = 'None' | 'PwD (40% or above)' | 'PwD (Below 40%)';
export type EducationLevelOption =
  | 'Class 11-12'
  | 'Diploma / Polytechnic'
  | 'Undergraduate (UG)'
  | 'Postgraduate (PG)'
  | 'PhD / Doctoral';
export type HostelOption = 'Hosteller' | 'Day Scholar';

export type ScholarshipType =
  | 'Central Government'
  | 'State Government'
  | 'Private'
  | 'Corporate'
  | 'University'
  | 'Merit-Based'
  | 'Need-Based'
  | 'Category-Based'
  | 'Private Foundation';

export type VerificationStatus =
  | 'Unverified'
  | 'Pending Review'
  | 'Verified'
  | 'Needs Correction'
  | 'Expired'
  | 'Archived'
  | 'Pending verification'
  | 'Needs verification'
  | 'Verified Official Source';

export type ApplicationCycleStatus =
  | 'Currently accepting applications'
  | 'Upcoming'
  | 'Closed'
  | 'Expired'
  | 'Status unknown';

export type DeadlineStatus = ApplicationCycleStatus | 'Open' | 'Closing Soon' | 'Check Official Portal';

export interface StudentProfile {
  uid: string;
  fullName: string;
  email: string;
  phone?: string;
  state?: string;
  district?: string;
  dateOfBirth?: string;
  gender?: GenderOption;
  category?: CategoryOption;
  disabilityStatus?: DisabilityOption;
  disabilityDetails?: string;
  educationLevel?: EducationLevelOption;
  courseSpecialization?: string;
  institutionName?: string;
  collegeLocation?: string;
  academicYear?: string;
  currentSemesterOrYear?: string;
  previousMarksPercent?: number | null;
  familyAnnualIncomeInr?: number | null;
  parentOccupation?: string;
  hostelStatus?: HostelOption;
  certificates?: string[];
  onboardingCompleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AppRole = 'student' | 'admin' | 'super_admin' | 'reviewer';

export interface UserRoleRecord {
  uid: string;
  role: AppRole;
  email?: string;
  displayName?: string;
  status?: 'active' | 'disabled';
  assignedBy?: string;
  assignedByEmail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Scholarship {
  id: string;
  title: string;
  provider: string;
  scholarshipType: ScholarshipType;
  description?: string;
  benefitsSummary?: string;
  financialBenefitsText?: string;
  annualAwardInr?: number | null;
  eligibilitySummary?: string;
  academicRequirements?: string;
  minIncomeLimitInr?: number | null;
  incomeLimitInr?: number | null;
  educationLevels?: string[];
  eligibleCourses?: string[];
  allowedCategories?: string[];
  eligibleStates?: string[];
  minMarksPercent?: number | null;
  genderRestriction?: 'All' | 'Female' | 'Male';
  disabilityRequired?: boolean;
  requiredDocuments?: string[];
  applicationStartDate?: string;
  applicationDeadline?: string;
  applicationProcess?: string;
  applicationStatus?: ApplicationCycleStatus;
  deadlineStatus?: DeadlineStatus;
  officialUrl: string;
  officialSourceUrl?: string;
  verificationStatus: VerificationStatus;
  lastVerifiedDate?: string;
  sourceNotes?: string;
  sourceName?: string;
  retrievedAt?: string;
  verifiedByUid?: string;
  verifiedByEmail?: string;
  verificationNotes?: string;
  sourceEvidence?: string;
  isActive?: boolean;
  archivedAt?: string;
  archivedByUid?: string;
  activeRuleVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export type EligibilityRuleOperator = 'lte' | 'gte' | 'in' | 'eq' | 'neq' | 'contains';

export interface ScholarshipEligibilityRule {
  id: string;
  scholarshipId: string;
  ruleKey: string;
  ruleLabel: string;
  operator: EligibilityRuleOperator;
  ruleValue: string;
  isMandatory: boolean;
  isActive?: boolean;
  versionNumber?: number;
  description?: string;
  updatedByUid?: string;
  createdAt: string;
  updatedAt?: string;
}

export type Phase8ApplicationStatus =
  | 'Interested'
  | 'Preparing'
  | 'Documents Pending'
  | 'Ready to Apply'
  | 'Submitted'
  | 'Under Review'
  | 'Correction Required'
  | 'Approved'
  | 'Rejected'
  | 'Withdrawn'
  | 'Closed';

export type LegacyApplicationStatus = 'Draft' | 'Documents Ready' | 'Awarded';

export type ApplicationStatus = Phase8ApplicationStatus | LegacyApplicationStatus;

export interface ApplicationRecord {
  id: string;
  userId: string;
  scholarshipId: string;
  scholarshipTitle: string;
  provider?: string;
  status: ApplicationStatus;
  portalReferenceId?: string;
  deadline?: string;
  notes?: string;
  submissionDate?: string;
  submissionConfirmedByStudent?: boolean;
  submissionConfirmedAt?: string;
  portalOpenedAt?: string;
  finalOutcome?: string;
  correctionNotes?: string;
  lastStatusChangedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ApplicationEventType =
  | 'Application Added'
  | 'Preparation Started'
  | 'Document Linked'
  | 'Checklist Updated'
  | 'Marked Ready'
  | 'External Portal Opened'
  | 'Submission Confirmed'
  | 'Status Changed'
  | 'Correction Requested'
  | 'Final Outcome Recorded'
  | 'Notes Updated';

export interface ApplicationEventRecord {
  id: string;
  applicationId: string;
  userId: string;
  scholarshipId: string;
  eventType: ApplicationEventType;
  fromStatus?: ApplicationStatus;
  toStatus?: ApplicationStatus;
  description: string;
  source: 'student' | 'system' | 'admin';
  actorUid: string;
  createdAt: string;
}

export type ChecklistManualStatus = 'Pending' | 'Completed' | 'Needs Attention';

export interface ApplicationChecklistItemRecord {
  id: string;
  applicationId: string;
  userId: string;
  scholarshipId: string;
  requirementName: string;
  isCompleted: boolean;
  manualStatus: ChecklistManualStatus;
  notes?: string;
  linkedDocumentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedScholarship {
  id: string;
  userId: string;
  scholarshipId: string;
  createdAt: string;
}

export type DocumentProcessingStatus =
  | 'Pending'
  | 'Processing'
  | 'Completed'
  | 'Failed'
  | 'Needs Review';

export type DocumentExtractionConfidence = 'High' | 'Medium' | 'Low';
export type DocumentReadabilityStatus = 'Readable' | 'Partially Readable' | 'Unreadable';
export type ExtractedFieldStatus = 'Extracted' | 'Absent' | 'Unreadable';

export interface ExtractedDocumentField {
  fieldName: string;
  value: string;
  confidence: DocumentExtractionConfidence;
  status: ExtractedFieldStatus;
  pageNumber?: number;
}

export interface DocumentRecord {
  id: string;
  userId: string;
  documentType: string;
  fileName: string;
  mimeType?: string;
  fileSizeBytes?: number | null;
  storagePath: string;
  downloadUrl?: string;
  storageProvider?: 'private-vault' | 'firebase-storage';
  verificationStatus: 'Uploaded' | 'Analyzed' | 'Needs Attention' | 'Verified';
  processingStatus?: DocumentProcessingStatus;
  errorDetails?: string;
  lastAnalyzedAt?: string;
  pageCount?: number;
  extractionMethod?: string;
  createdAt: string;
  updatedAt: string;
}

export type MarksheetSubjectRole = 'main' | 'additional' | 'uncertain' | 'excluded';
export type MarksheetValueSource = 'document-extracted' | 'ai-calculated';
export type MarksheetConfirmationStatus =
  | 'Auto-Calculated'
  | 'Needs Confirmation'
  | 'Confirmed by Student';

export interface MarksheetSubjectEntry {
  subjectCode?: string;
  subjectName: string;
  subjectCategory: MarksheetSubjectRole;
  theoryMarks: number | null;
  internalOrPracticalMarks: number | null;
  printedTotalMarks: number | null;
  calculatedTotalMarks: number | null;
  effectiveTotalMarks: number | null;
  maxMarks: number | null;
  grade?: string;
  resultStatus?: string;
  totalSource: MarksheetValueSource;
  hasArithmeticDiscrepancy?: boolean;
  discrepancyNote?: string;
  pageNumber?: number;
}

export interface MarksheetAggregateBreakdown {
  label: string;
  subjectCount: number;
  obtainedMarks: number;
  maximumMarks: number;
  percentage: number;
  sourceType: MarksheetValueSource;
  includedSubjects: string[];
}

export interface MarksheetExtractionSummary {
  boardOrUniversity: string;
  examinationName: string;
  examClassOrLevel: string;
  applicableRule: string;
  hasPrintedOverallAggregate: boolean;
  printedOverallObtainedMarks?: number | null;
  printedOverallMaxMarks?: number | null;
  printedOverallPercentage?: number | null;
  subjects: MarksheetSubjectEntry[];
  mainAggregate?: MarksheetAggregateBreakdown | null;
  aggregateIncludingAdditional?: MarksheetAggregateBreakdown | null;
  requiresUserConfirmation: boolean;
  confirmationStatus: MarksheetConfirmationStatus;
  confirmationReasons: string[];
  calculationNotes: string[];
}

export interface DocumentAnalysis {
  id: string;
  userId: string;
  documentId: string;
  detectedType: string;
  readabilityStatus?: DocumentReadabilityStatus;
  extractionMethod?: string;
  pageCount?: number;
  rawTextPreview?: string;
  issuingAuthority?: string;
  validityNotes?: string;
  expiryWarning?: string;
  overallConfidence?: DocumentExtractionConfidence;
  extractedFields?: ExtractedDocumentField[];
  marksheetSummary?: MarksheetExtractionSummary;
  missingFields?: string[];
  unreadableFields?: string[];
  profileMismatches?: string[];
  manualVerificationItems?: string[];
  issuesFound?: string[];
  recommendations?: string[];
  readinessVerdict: 'Ready' | 'Needs Clarification' | 'Incomplete';
  disclaimer?: string;
  createdAt: string;
}

export type EligibilityOverallStatus =
  | 'Eligible'
  | 'Potentially Eligible'
  | 'Not Eligible'
  | 'Insufficient Information'
  | 'Scholarship Status Unverified';

export type CriterionEvaluationStatus = 'Passed' | 'Failed' | 'Unknown' | 'Not Applicable';

export interface EligibilityCriterionResult {
  criterion: string;
  status: CriterionEvaluationStatus;
  detail: string;
  missingFieldKey?: keyof StudentProfile;
  missingFieldReason?: string;
}

export interface EligibilityAssessment {
  id: string;
  userId: string;
  scholarshipId: string;
  scholarshipTitle?: string;
  overallStatus: EligibilityOverallStatus | 'Partially Eligible';
  compatibilityScore?: number;
  passedCriteria?: string[];
  failedCriteria?: string[];
  unknownCriteria?: string[];
  notApplicableCriteria?: string[];
  scoreFormulaSummary?: string;
  criteriaBreakdown?: EligibilityCriterionResult[];
  aiExplanation?: string;
  ruleVersionUsed?: number;
  rulesAppliedCount?: number;
  createdAt: string;
}

export interface EligibilityAssessmentDetail {
  id: string;
  assessmentId: string;
  userId: string;
  scholarshipId: string;
  criterion: string;
  status: CriterionEvaluationStatus;
  detail: string;
  missingFieldKey?: string;
  missingFieldReason?: string;
  createdAt: string;
}

export type ReadinessAssessmentStatus =
  | 'Ready'
  | 'Partially Ready'
  | 'Needs Preparation'
  | 'Assessment Incomplete'
  | 'No Scholarship Data';

export type ReadinessDimensionKey =
  | 'profile'
  | 'academic'
  | 'documents'
  | 'eligibility'
  | 'application';

export interface ReadinessDimensionScore {
  key: ReadinessDimensionKey;
  label: string;
  weightPercent: number;
  maxPoints: number;
  earnedPoints: number;
  scorePercent: number | null;
  status: 'Strong' | 'Moderate' | 'Needs Attention' | 'Incomplete' | 'Unavailable';
  summary: string;
  completedRequirements: string[];
  incompleteRequirements: string[];
  deductionReasons: string[];
}

export interface ScholarshipSpecificReadiness {
  scholarshipId: string;
  scholarshipTitle: string;
  provider: string;
  scholarshipType: ScholarshipType;
  verificationStatus: VerificationStatus;
  isSourceVerified: boolean;
  officialUrl: string;
  applicationDeadline: string;
  effectiveApplicationStatus: ApplicationCycleStatus;
  eligibilityStatus: EligibilityOverallStatus;
  compatibilityScore: number;
  readinessPercent: number | null;
  readinessLabel:
    | 'Application Ready'
    | 'Nearly Ready'
    | 'Preparation Needed'
    | 'Blocked — Missing Info'
    | 'Not Eligible'
    | 'Status Unverified';
  requiredDocuments: string[];
  availableDocuments: string[];
  needsReviewDocuments: string[];
  missingDocuments: string[];
  failedCriteria: string[];
  unknownCriteria: string[];
  missingProfileFields: string[];
  trackerStatus: ApplicationStatus | 'Not Tracked';
  nextRecommendedAction: string;
  isSaved: boolean;
}

export type ReadinessActionPriority = 'High' | 'Medium' | 'Low';
export type ReadinessActionStatus = 'Pending' | 'In Progress' | 'Completed';

export interface ReadinessActionItem {
  id: string;
  title: string;
  explanation: string;
  relatedScholarshipId?: string;
  relatedScholarshipTitle?: string;
  unblocksCount: number;
  priority: ReadinessActionPriority;
  status: ReadinessActionStatus;
  sourceOfRequirement: string;
  suggestedNextStep: string;
  actionRoute?: string;
}

export interface ReadinessAssessment {
  id: string;
  userId: string;
  readinessPercent: number;
  overallScore?: number | null;
  assessmentStatus?: ReadinessAssessmentStatus;
  algorithmVersion?: string;
  dataFingerprint?: string;
  dataAvailabilityWarning?: string;
  disclaimer?: string;
  profileCompletenessPercent?: number;
  documentCoveragePercent?: number;
  dimensionScores?: ReadinessDimensionScore[];
  completedRequirements?: string[];
  incompleteRequirements?: string[];
  deductionReasons?: string[];
  missingItems?: string[];
  scholarshipReadiness?: ScholarshipSpecificReadiness[];
  recommendedActions?: ReadinessActionItem[];
  aiActionPlan?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface AIConversation {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AIMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export type TrustGuardVerificationStatus =
  | 'Not Analyzed'
  | 'Analysis In Progress'
  | 'Consistency Check Completed'
  | 'Manual Review Required'
  | 'Information Mismatch Detected'
  | 'Unable to Verify'
  | 'Verified Against Available Records';

export type TrustGuardRiskSeverity =
  | 'Critical'
  | 'High'
  | 'Medium'
  | 'Low'
  | 'Informational';

export type TrustGuardFindingCategory =
  | 'Identity Consistency'
  | 'Academic Consistency'
  | 'Income Consistency'
  | 'Category & Residence Consistency'
  | 'Document Completeness'
  | 'Scholarship Requirement Gap'
  | 'Duplicate Upload';

export type TrustGuardReviewStatus = 'Unreviewed' | 'Reviewed' | 'Correction Planned';

export interface TrustGuardAffectedDocument {
  documentId: string;
  fileName: string;
  documentType: string;
}

export interface TrustGuardEvidenceValue {
  sourceLabel: string;
  fieldName: string;
  value: string;
}

export interface TrustGuardFinding {
  findingId: string;
  evidenceFingerprint: string;
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
  reviewStatus: TrustGuardReviewStatus;
  studentNote?: string;
  reviewedAt?: string;
  changeState?: 'New' | 'Unchanged';
}

export interface TrustGuardDocumentResult {
  documentId: string;
  fileName: string;
  documentType: string;
  detectedType?: string;
  verificationStatus: TrustGuardVerificationStatus;
  processingStatus?: DocumentProcessingStatus;
  readabilityStatus?: DocumentReadabilityStatus;
  overallConfidence?: DocumentExtractionConfidence;
  findingCount: number;
  highestSeverity?: TrustGuardRiskSeverity;
  summaryNote: string;
  checkedFields: string[];
}

export interface TrustGuardSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
}

export interface TrustGuardChangeSummary {
  previousAssessmentId?: string;
  previousAssessedAt?: string;
  newFindingIds: string[];
  resolvedFindingIds: string[];
  resolvedFindingTitles: string[];
  unchangedFindingIds: string[];
}

export interface TrustGuardDocumentAssessment {
  id: string;
  userId: string;
  analysisVersion: string;
  dataFingerprint: string;
  overallVerificationStatus: TrustGuardVerificationStatus;
  documentsTotalCount: number;
  documentsAnalyzedCount: number;
  severityCounts: TrustGuardSeverityCounts;
  documentResults: TrustGuardDocumentResult[];
  findings: TrustGuardFinding[];
  correctiveActions: string[];
  changeSummary?: TrustGuardChangeSummary;
  aiSummary?: string;
  limitationNotice: string;
  disclaimer: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrustGuardReport {
  id: string;
  userId: string;
  reportCategory?: 'scam_check' | 'document_consistency';
  submittedUrlOrText: string;
  claimsFeeOrDeposit?: boolean;
  riskLevel: 'Low Risk' | 'Caution' | 'High Risk' | 'Unassessed';
  analysisSummary?: string;
  status: 'Open' | 'Under Review' | 'Verified Safe' | 'Confirmed Scam';
  adminNotes?: string;
  createdAt: string;
  updatedAt: string;
}

export type NotificationCategory =
  | 'Scholarship'
  | 'Application'
  | 'Document'
  | 'Readiness'
  | 'Account'
  | 'Deadline'
  | 'Eligibility'
  | 'TrustGuard'
  | 'Checklist'
  | 'System';

export type NotificationSubCategory =
  | 'Scholarship Match'
  | 'Eligibility Change'
  | 'Deadline Reminder'
  | 'New Opportunity'
  | 'Status Changed'
  | 'Correction Required'
  | 'Outcome Update'
  | 'Submission Update'
  | 'Processing Completed'
  | 'Processing Failed'
  | 'Manual Review Required'
  | 'Missing Document'
  | 'Consistency Risk'
  | 'Readiness Updated'
  | 'Missing Requirements'
  | 'Action Plan Updated'
  | 'Account Activity'
  | 'Security Alert'
  | 'Admin Announcement';

export type NotificationDeliveryChannel = 'in-app' | 'email' | 'in-app+email';
export type NotificationDeliveryStatus =
  | 'Delivered In-App'
  | 'Email Pending'
  | 'Email Sent'
  | 'Email Delivered'
  | 'Email Failed'
  | 'Email Not Configured';

export interface NotificationRecord {
  id: string;
  userId: string;
  title: string;
  message: string;
  category?: NotificationCategory;
  subCategory?: NotificationSubCategory | string;
  priority?: 'High' | 'Medium' | 'Low';
  applicationId?: string;
  scholarshipId?: string;
  documentId?: string;
  announcementId?: string;
  officialSourceUrl?: string;
  verifiedDeadline?: string;
  actionRoute?: string;
  dedupeKey?: string;
  deliveryChannel?: NotificationDeliveryChannel;
  deliveryStatus?: NotificationDeliveryStatus;
  isRead: boolean;
  readAt?: string;
  isArchived?: boolean;
  archivedAt?: string;
  createdAt: string;
}

export interface NotificationPreferenceRecord {
  uid: string;
  scholarshipAlertsEnabled?: boolean;
  applicationAlertsEnabled?: boolean;
  documentAlertsEnabled?: boolean;
  readinessAlertsEnabled?: boolean;
  accountSecurityAlertsEnabled?: boolean;
  deadlineRemindersEnabled: boolean;
  deadlineIntervalsDays?: number[];
  missingDocsAlertsEnabled: boolean;
  statusChangeAlertsEnabled: boolean;
  emailDigestRequested: boolean;
  emailNotificationsEnabled?: boolean;
  emailDeliveryStatus: string;
  updatedAt: string;
}

export type EmailDeliveryStatus =
  | 'Pending'
  | 'Sent'
  | 'Delivered'
  | 'Failed'
  | 'Not Configured';

export interface NotificationDeliveryLogRecord {
  id: string;
  userId: string;
  notificationId?: string;
  recipientEmail?: string;
  channel: 'email' | 'in-app';
  provider: string;
  idempotencyKey: string;
  status: EmailDeliveryStatus;
  attempts: number;
  httpStatus?: number;
  providerMessageId?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type AnnouncementAudience =
  | 'all'
  | 'onboarded'
  | 'pending_onboarding'
  | 'filtered';

export type AnnouncementStatus =
  | 'Draft'
  | 'Scheduled'
  | 'Published'
  | 'Expired'
  | 'Unpublished';

export interface AdminAnnouncementRecord {
  id: string;
  title: string;
  message: string;
  category: 'Scholarship' | 'Account' | 'System' | 'Deadline' | 'Maintenance';
  targetAudience: AnnouncementAudience;
  targetStates?: string[];
  targetEducationLevels?: string[];
  status: AnnouncementStatus;
  publishAt?: string;
  expiresAt?: string;
  actionRoute?: string;
  deliveredCount?: number;
  createdByUid: string;
  createdByEmail: string;
  publishedByUid?: string;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledNotificationRunRecord {
  id: string;
  triggerType: 'startup' | 'cron_interval' | 'admin_manual' | 'user_sync';
  status: 'Completed' | 'Partial' | 'Failed' | 'Skipped (No Server Credentials)';
  startedAt: string;
  completedAt: string;
  scholarshipsEvaluated: number;
  applicationsEvaluated: number;
  studentsEvaluated: number;
  alertsGenerated: number;
  emailsAttempted: number;
  emailsSent: number;
  emailsFailed: number;
  errorSummary?: string;
  triggeredByUid?: string;
}

export const INDIAN_STATES_AND_UTS = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Delhi (NCT)',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu & Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman & Nicobar Islands',
  'Chandigarh',
  'Dadra & Nagar Haveli and Daman & Diu',
  'Lakshadweep',
] as const;

export const STANDARD_CERTIFICATES = [
  'Aadhaar Card',
  'Income Certificate (Tehsildar / Competent Authority)',
  'Caste / Category / EWS Certificate',
  'Domicile / Residence Certificate',
  'Previous Academic Marksheet',
  'Current Year Bonafide / Fee Receipt',
  'Bank Passbook (Aadhaar-Seeded)',
  'Disability (UDID) Certificate',
] as const;

export const DOCUMENT_CATEGORIES = [
  'Aadhaar / Identity Document',
  'Income Certificate',
  'Caste Certificate',
  'Domicile Certificate',
  'Academic Marksheet',
  'Bonafide Certificate',
  'Admission Letter',
  'Fee Receipt',
  'Bank Passbook',
  'Disability Certificate',
  'Other Scholarship Document',
] as const;

export type DocumentCategoryOption = (typeof DOCUMENT_CATEGORIES)[number];

// ============================================================================
// Phase 9: Admin Control Center & Scholarship Data Governance Types
// ============================================================================

export type AdminAuditAction =
  | 'Admin Login'
  | 'Admin Access Verified'
  | 'Scholarship Created'
  | 'Scholarship Updated'
  | 'Scholarship Archived'
  | 'Scholarship Verification Changed'
  | 'Rule Created'
  | 'Rule Updated'
  | 'Rule Deactivated'
  | 'Data Quality Scan'
  | 'Data Quality Issue Resolved'
  | 'Sensitive Student Record Accessed'
  | 'Document Retry Triggered'
  | 'TrustGuard Report Moderated'
  | 'Role Updated'
  | 'Announcement Created'
  | 'Announcement Updated'
  | 'Announcement Published'
  | 'Announcement Unpublished'
  | 'Scheduled Notification Run';

export type AdminAuditEntityType =
  | 'session'
  | 'scholarship'
  | 'eligibility_rule'
  | 'data_quality'
  | 'student'
  | 'document'
  | 'trustguard_report'
  | 'user_role'
  | 'announcement'
  | 'notification_run';

export interface AdminAuditLogRecord {
  id: string;
  adminUid: string;
  adminEmail: string;
  adminRole: 'admin' | 'super_admin';
  action: AdminAuditAction;
  entityType: AdminAuditEntityType;
  entityId: string;
  summary: string;
  changesSummary?: string;
  requestId?: string;
  createdAt: string;
}

export interface ScholarshipVerificationHistoryRecord {
  id: string;
  scholarshipId: string;
  scholarshipTitle: string;
  previousStatus: VerificationStatus;
  newStatus: VerificationStatus;
  sourceName?: string;
  officialSourceUrl: string;
  sourceEvidence: string;
  verificationNotes?: string;
  httpCheckStatus?: number | null;
  adminUid: string;
  adminEmail: string;
  createdAt: string;
}

export interface ScholarshipRuleSnapshotItem {
  id: string;
  ruleKey: string;
  ruleLabel: string;
  operator: EligibilityRuleOperator;
  ruleValue: string;
  isMandatory: boolean;
  isActive: boolean;
}

export interface ScholarshipRuleVersionRecord {
  id: string;
  scholarshipId: string;
  versionNumber: number;
  changeSummary: string;
  rulesSnapshot: ScholarshipRuleSnapshotItem[];
  changedByUid: string;
  changedByEmail: string;
  createdAt: string;
}

export type DataQualityIssueType =
  | 'Duplicate Candidate'
  | 'Missing Official URL'
  | 'Missing Deadline'
  | 'Invalid Date Range'
  | 'Missing Eligibility Criteria'
  | 'Incomplete Record'
  | 'Conflicting Information'
  | 'Expired Marked Active'
  | 'Unverified Source Risk'
  | 'Outdated Verification';

export type DataQualitySeverity = 'Critical' | 'High' | 'Medium' | 'Low';
export type DataQualityResolutionStatus = 'Open' | 'Acknowledged' | 'Resolved' | 'Ignored';

export interface DataQualityIssueRecord {
  id: string;
  scholarshipId: string;
  scholarshipTitle: string;
  relatedScholarshipId?: string;
  relatedScholarshipTitle?: string;
  issueType: DataQualityIssueType;
  severity: DataQualitySeverity;
  description: string;
  recommendedCorrection: string;
  resolutionStatus: DataQualityResolutionStatus;
  detectedAt: string;
  resolvedAt?: string;
  resolvedByUid?: string;
  resolutionNote?: string;
  updatedAt: string;
}

export interface AdminDashboardMetrics {
  generatedAt: string;
  platform: {
    totalStudents: number;
    activeStudentAccounts: number;
    activeStudentDefinition: string;
    totalScholarships: number;
    verifiedScholarships: number;
    unverifiedScholarships: number;
    expiredScholarships: number;
    reviewRequiredScholarships: number;
    archivedScholarships: number;
    totalApplications: number;
    applicationStatusCounts: Record<string, number>;
    documentJobsTotal: number;
    documentJobsByStatus: {
      Pending: number;
      Processing: number;
      Completed: number;
      Failed: number;
      'Needs Review': number;
    };
    trustGuardReportsTotal: number;
    trustGuardOpenReports: number;
    trustGuardAssessmentsTotal: number;
    trustGuardFindingsBySeverity: TrustGuardSeverityCounts;
    trustGuardAwaitingReview: number;
    trustGuardResolvedFindings: number;
    trustGuardAnalysisFailures: number;
  };
  dataQuality: {
    missingOfficialUrls: number;
    missingDeadlines: number;
    missingEligibilityRules: number;
    duplicateCandidates: number;
    incompleteRecords: number;
    outdatedVerificationTimestamps: number;
    expiredMarkedActive: number;
    totalOpenIssues: number;
  };
}

export interface AdminStudentOversightItem {
  uid: string;
  displayName: string;
  maskedEmail: string;
  state?: string;
  educationLevel?: string;
  onboardingCompleted: boolean;
  accountStatus: 'Active (Onboarded)' | 'Pending Onboarding';
  applicationCount: number;
  applicationStatusCounts: Record<string, number>;
  documentCount: number;
  failedDocumentCount: number;
  latestTrustGuardStatus?: TrustGuardVerificationStatus;
  updatedAt: string;
}

