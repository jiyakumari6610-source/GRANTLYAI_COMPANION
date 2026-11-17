import { Link } from 'react-router-dom';
import { AlertTriangle, HelpCircle, LifeBuoy, ShieldCheck } from 'lucide-react';
import { PublicLegalShell } from '../components/PublicLegalShell.tsx';

export default function SupportGrievancePage() {
  return (
    <PublicLegalShell
      eyebrow="Help & Governance"
      title="Support & Grievance Notice"
      subtitle="Guidance for common student workspace questions, scam reporting, and required contact details for public operation."
      lastUpdated="2026-11-17"
    >
      <section className="p-5 rounded-2xl bg-amber-500/10 border border-amber-500/30 space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Owner Action Required: Supply Official Support &amp; Grievance Contacts</span>
        </div>
        <p className="text-xs sm:text-sm text-amber-100/90 leading-relaxed">
          No support email address, phone number, or physical office address has been fabricated in this release. Before opening to the general public, the deployment owner must publish verified contact channels below:
        </p>
        <div className="grid sm:grid-cols-2 gap-3 pt-1 text-xs">
          <div className="p-3.5 rounded-xl bg-[#070C1B]/80 border border-amber-500/25 space-y-1">
            <p className="font-semibold text-amber-200">Student Support Contact</p>
            <p className="text-slate-300">Email: [Owner to supply verified support email]</p>
            <p className="text-slate-400">Response Window: [Owner to supply SLA]</p>
          </div>
          <div className="p-3.5 rounded-xl bg-[#070C1B]/80 border border-amber-500/25 space-y-1">
            <p className="font-semibold text-amber-200">Designated Grievance Officer</p>
            <p className="text-slate-300">Officer Name &amp; Role: [Owner to supply]</p>
            <p className="text-slate-400">Grievance Email &amp; Address: [Owner to supply]</p>
          </div>
        </div>
      </section>

      <section className="surface-card rounded-2xl p-6 space-y-4">
        <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
          <HelpCircle className="w-4 h-4 text-indigo-400" />
          <span>1. Common Public Beta Questions</span>
        </h2>
        <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
          <div>
            <p className="font-semibold text-white">Why is document upload currently unavailable?</p>
            <p className="text-slate-400 mt-0.5">
              Document binary upload in Document Intelligence is paused for this free-tier public beta because persistent Cloud Storage is not enabled. Scholarship Discovery, Eligibility Checker, AI Companion, Readiness Score, TrustGuard link checking, and Application Tracker remain active.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white">Why can&apos;t I sign in with Email/Password?</p>
            <p className="text-slate-400 mt-0.5">
              Use &ldquo;Continue with Google&rdquo; on the Sign In or Registration page. Google Sign-In verifies your email automatically and connects your isolated workspace immediately.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white">How do I verify an official scholarship deadline or payment status?</p>
            <p className="text-slate-400 mt-0.5">
              Always open the official portal URL listed inside each scheme&apos;s detail page (such as scholarships.gov.in or the state/foundation portal) to confirm active dates and submit your application directly.
            </p>
          </div>
        </div>
      </section>

      <section className="surface-card rounded-2xl p-6 space-y-3">
        <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>2. Reporting Suspicious Scholarship Links or Fee Demands</span>
        </h2>
        <p className="text-sm text-slate-300 leading-relaxed">
          Verified government and foundation scholarships do not charge registration fees, demand UPI transfers, or ask for bank OTPs. If you encounter a suspicious scholarship URL or message:
        </p>
        <ul className="list-disc list-inside text-sm text-slate-300 space-y-1.5 leading-relaxed">
          <li>
            Signed-in students can submit the URL or message inside{' '}
            <Link to="/trustguard" className="text-indigo-300 hover:underline font-medium">
              TrustGuard
            </Link>{' '}
            for risk analysis and administrator moderation review.
          </li>
          <li>
            If you believe you were targeted by financial fraud or impersonation, report the incident immediately through official national cybercrime reporting portals or the official helpline listed on your state/central scholarship portal.
          </li>
        </ul>
      </section>

      <section className="surface-card rounded-2xl p-6 space-y-3">
        <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
          <LifeBuoy className="w-4 h-4 text-blue-400" />
          <span>3. Related Documentation</span>
        </h2>
        <div className="flex flex-wrap gap-3 text-xs">
          <Link
            to="/privacy"
            className="px-4 py-2 rounded-xl bg-slate-900/80 border border-slate-700/80 text-slate-200 hover:border-indigo-400/50 hover:text-white"
          >
            Read Privacy Policy
          </Link>
          <Link
            to="/terms"
            className="px-4 py-2 rounded-xl bg-slate-900/80 border border-slate-700/80 text-slate-200 hover:border-indigo-400/50 hover:text-white"
          >
            Read Terms of Service
          </Link>
          <Link
            to="/dashboard"
            className="px-4 py-2 rounded-xl btn-primary-gradient font-semibold text-white"
          >
            Return to Workspace
          </Link>
        </div>
      </section>
    </PublicLegalShell>
  );
}
