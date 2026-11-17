import { AlertTriangle, Database, Lock, ShieldCheck } from 'lucide-react';
import { PublicLegalShell } from '../components/PublicLegalShell.tsx';

export default function PrivacyPolicyPage() {
  return (
    <PublicLegalShell
      eyebrow="Privacy & Data Protection"
      title="Privacy Policy"
      subtitle="Transparent summary of what student information GRANTLY AI collects, how it is processed with Firebase and Gemini AI, and how access is isolated."
      lastUpdated="2026-11-17"
    >
      <section className="p-5 rounded-2xl bg-amber-500/10 border border-amber-500/30 space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Owner Information Required Before Broad Public Launch</span>
        </div>
        <p className="text-xs sm:text-sm text-amber-100/90 leading-relaxed">
          This policy accurately describes the technical implementation of GRANTLY AI. Before broad public distribution, the deployment operator must fill in the following legal disclosures in this document:
        </p>
        <ul className="list-disc list-inside text-xs text-amber-200/90 space-y-1">
          <li><strong>Operator / Legal Entity Name:</strong> [To be supplied by project owner]</li>
          <li><strong>Registered Physical Address:</strong> [To be supplied by project owner]</li>
          <li><strong>Privacy Contact Email:</strong> [To be supplied by project owner]</li>
          <li><strong>Data Retention &amp; Deletion Request SLA:</strong> [To be supplied by project owner]</li>
        </ul>
      </section>

      <section className="surface-card rounded-2xl p-6 space-y-3">
        <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
          <Database className="w-4 h-4 text-indigo-400" />
          <span>1. Information Actually Collected</span>
        </h2>
        <p className="text-sm text-slate-300 leading-relaxed">
          GRANTLY AI collects only the information you provide directly when creating an account and using scholarship preparation workflows:
        </p>
        <ul className="list-disc list-inside text-sm text-slate-300 space-y-1.5 leading-relaxed">
          <li>
            <strong>Authentication Account Data (Firebase Authentication):</strong> Your Firebase user ID (UID), email address, email verification status, and display name when signing in via Google Sign-In or Email/Password (when enabled).
          </li>
          <li>
            <strong>Student Eligibility Profile:</strong> Name, phone number (optional), domicile state and district, date of birth, gender, social category, disability status/details, education level, course specialization, institution name and location, academic year/semester, marks percentage, family annual income (INR), parent occupation, hostel status, and checklist of held certificate types.
          </li>
          <li>
            <strong>Scholarship &amp; Application Workspace Data:</strong> Saved scholarships, deterministic eligibility audit records, readiness assessments, AI Companion chat threads and messages, tracked scholarship application statuses, checklists, timeline events, TrustGuard link/consistency checks, and notification preferences.
          </li>
          <li>
            <strong>Document Uploads (Temporarily Paused in Public Beta):</strong> Binary document file uploads are disabled in the current public beta because persistent Cloud Storage is not enabled on this deployment. Any previously stored document metadata or extraction summaries remain isolated under your UID.
          </li>
        </ul>
      </section>

      <section className="surface-card rounded-2xl p-6 space-y-3">
        <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-blue-400" />
          <span>2. How Information Is Used &amp; Processed</span>
        </h2>
        <ul className="list-disc list-inside text-sm text-slate-300 space-y-1.5 leading-relaxed">
          <li>
            <strong>Deterministic Scholarship Matching &amp; Readiness:</strong> Profile signals are evaluated against published scholarship rules to compute pass/fail/unknown criteria, readiness scores, and deadline reminders.
          </li>
          <li>
            <strong>Server-Side AI Assistance (Google Gemini API):</strong> When you submit a question in AI Companion, request an Explainable Eligibility briefing, generate a Readiness Action Plan, or run a TrustGuard explanation, relevant workspace context is forwarded over HTTPS from our backend server to the Google Gemini API. API credentials stay strictly on the server and are never embedded in browser code.
          </li>
          <li>
            <strong>In-App Notifications:</strong> Deadline, readiness, and status alerts are delivered inside the application. External transactional email sending is not active during this public beta.
          </li>
          <li>
            <strong>No Advertising or Data Brokerage:</strong> GRANTLY AI does not sell student data, display third-party advertising trackers, or share private student profiles with external scholarship brokers.
          </li>
        </ul>
      </section>

      <section className="surface-card rounded-2xl p-6 space-y-3">
        <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
          <Lock className="w-4 h-4 text-emerald-400" />
          <span>3. Storage Security &amp; Access Controls</span>
        </h2>
        <ul className="list-disc list-inside text-sm text-slate-300 space-y-1.5 leading-relaxed">
          <li>
            <strong>User Isolation:</strong> Student profiles, assessments, saved schemes, AI messages, applications, and notifications are stored in Cloud Firestore and isolated by Firebase Authentication UID under Firestore Security Rules. Public users cannot list or read private student records.
          </li>
          <li>
            <strong>Verified Identity &amp; Role Separation:</strong> Protected backend API routes require valid Firebase ID tokens and verified email accounts. Administrative operations (such as publishing scholarship catalog updates or reviewing TrustGuard reports) require server-verified administrator roles and write to append-only audit logs.
          </li>
          <li>
            <strong>Student Control:</strong> You can edit your profile fields, delete saved applications, delete AI conversation threads, or update notification preferences at any time inside your workspace.
          </li>
        </ul>
      </section>

      <section className="surface-card rounded-2xl p-6 space-y-2.5">
        <h2 className="text-base font-semibold text-white font-display">
          4. Third-Party Links &amp; External Portals
        </h2>
        <p className="text-sm text-slate-300 leading-relaxed">
          GRANTLY AI provides links to official government, institutional, and foundation scholarship portals (such as NSP, State DBT portals, AICTE, and UGC). Once you open an external portal, that portal&apos;s own privacy policy and terms govern your application submission.
        </p>
      </section>
    </PublicLegalShell>
  );
}
