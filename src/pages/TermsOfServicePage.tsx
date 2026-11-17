import { AlertTriangle, FileCheck2, Scale, ShieldAlert } from 'lucide-react';
import { PublicLegalShell } from '../components/PublicLegalShell.tsx';

export default function TermsOfServicePage() {
  return (
    <PublicLegalShell
      eyebrow="Terms & Conditions"
      title="Terms of Service"
      subtitle="Rules, scope of advisory guidance, and student responsibilities when using the GRANTLY AI public beta."
      lastUpdated="2026-11-17"
    >
      <section className="p-5 rounded-2xl bg-amber-500/10 border border-amber-500/30 space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Owner Information Required Before Broad Public Launch</span>
        </div>
        <p className="text-xs sm:text-sm text-amber-100/90 leading-relaxed">
          Before broad public commercial or institutional release, the deployment owner must supply the following legal particulars:
        </p>
        <ul className="list-disc list-inside text-xs text-amber-200/90 space-y-1">
          <li><strong>Contracting Entity / Operator Name:</strong> [To be supplied by project owner]</li>
          <li><strong>Governing Law &amp; Jurisdiction (State/City):</strong> [To be supplied by project owner]</li>
          <li><strong>Official Legal / Terms Contact Email:</strong> [To be supplied by project owner]</li>
        </ul>
      </section>

      <section className="surface-card rounded-2xl p-6 space-y-3">
        <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
          <FileCheck2 className="w-4 h-4 text-indigo-400" />
          <span>1. Advisory Nature of Platform (No Automated Filing or Award Guarantee)</span>
        </h2>
        <ul className="list-disc list-inside text-sm text-slate-300 space-y-1.5 leading-relaxed">
          <li>
            GRANTLY AI is a scholarship discovery, eligibility pre-check, readiness planning, and application tracking assistant.
          </li>
          <li>
            <strong>No Official Submission:</strong> GRANTLY AI does not submit applications to the National Scholarship Portal (NSP), state portals, AICTE, UGC, or private foundations on your behalf. You must complete final submission on the official portal directly.
          </li>
          <li>
            <strong>No Guarantee of Eligibility or Selection:</strong> Compatibility scores, readiness percentages, and AI explanations reflect rule comparisons against your self-reported profile data and published scheme summaries. Official scholarship authorities make final eligibility and award decisions.
          </li>
          <li>
            <strong>TrustGuard Scope:</strong> TrustGuard helps identify suspicious portal patterns, fee-scam red flags, and profile-to-document consistency gaps. It does not issue legal authentication or government certification of any document or website.
          </li>
        </ul>
      </section>

      <section className="surface-card rounded-2xl p-6 space-y-3">
        <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-blue-400" />
          <span>2. Public Beta Availability &amp; Current Limitations</span>
        </h2>
        <ul className="list-disc list-inside text-sm text-slate-300 space-y-1.5 leading-relaxed">
          <li>
            During this public beta, Scholarship Discovery, Deterministic Eligibility Checking, AI Companion, Readiness Scoring, TrustGuard Link &amp; Consistency Checks, Application Tracker, and In-App Notifications are active.
          </li>
          <li>
            <strong>Document Binary Upload Paused:</strong> New document file uploads and file replacements in Document Intelligence are temporarily unavailable because persistent Cloud Storage is not enabled on the current free-tier deployment.
          </li>
          <li>
            <strong>Email Alerts Paused:</strong> External email notifications are inactive during public beta; alerts remain accessible in your in-app Notification Center.
          </li>
          <li>
            GRANTLY AI is provided free of charge during public beta. Never pay any fee to anyone claiming to represent GRANTLY AI or any verified government scholarship portal.
          </li>
        </ul>
      </section>

      <section className="surface-card rounded-2xl p-6 space-y-3">
        <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
          <Scale className="w-4 h-4 text-emerald-400" />
          <span>3. Acceptable Use &amp; Account Responsibilities</span>
        </h2>
        <ul className="list-disc list-inside text-sm text-slate-300 space-y-1.5 leading-relaxed">
          <li>
            Provide accurate academic, income, and domicile details in your own profile and verify official scheme deadlines and instructions on the linked source website before applying.
          </li>
          <li>
            Do not attempt to access another student&apos;s records, bypass authentication or rate limits, inject malicious prompts or payloads, or scrape API endpoints in an automated manner.
          </li>
          <li>
            AI-generated responses may occasionally omit nuances in updated government circulars; always cross-check official scheme guidelines linked inside each scholarship card.
          </li>
        </ul>
      </section>
    </PublicLegalShell>
  );
}
