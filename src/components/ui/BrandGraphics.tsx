import { motion } from 'motion/react';
import { Award, CheckCircle2, FileSearch, ShieldCheck } from 'lucide-react';

export function GrantlyLogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="shrink-0"
    >
      <defs>
        <linearGradient id="grantlyLogoGrad" x1="2" y1="2" x2="34" y2="34" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366F1" />
          <stop offset="0.55" stopColor="#3B82F6" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="32" height="32" rx="9" fill="url(#grantlyLogoGrad)" fillOpacity="0.16" stroke="url(#grantlyLogoGrad)" strokeWidth="1.5" />
      <path
        d="M18 8.5L26 12.7V18.8C26 23.4 22.5 27.1 18 28.5C13.5 27.1 10 23.4 10 18.8V12.7L18 8.5Z"
        fill="url(#grantlyLogoGrad)"
        fillOpacity="0.22"
        stroke="#A5B4FC"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M14.8 18.2L17.1 20.5L21.8 15.6"
        stroke="#E0E7FF"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Interactive 3D-layered architectural intelligence panel for the Landing Page hero.
 * Strictly represents platform workflows and capabilities without fabricating student counts.
 */
export function HeroIntelligenceVisual() {
  return (
    <div className="relative h-full min-h-[380px] lg:min-h-[450px] rounded-2xl surface-elevated overflow-hidden p-5 sm:p-7 flex flex-col justify-between">
      {/* Subtle geometric backdrop SVG */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none opacity-45"
        viewBox="0 0 600 460"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id="heroNodeGlow" cx="50%" cy="35%" r="60%">
            <stop offset="0%" stopColor="#6366F1" stopOpacity="0.28" />
            <stop offset="60%" stopColor="#3B82F6" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#050914" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="600" height="460" fill="url(#heroNodeGlow)" />
        <path
          d="M60 110H220L270 160H490M90 340H260L310 285H530"
          stroke="rgba(129, 140, 248, 0.2)"
          strokeWidth="1.2"
          strokeDasharray="4 4"
        />
        <circle cx="220" cy="110" r="3.5" fill="#818CF8" />
        <circle cx="270" cy="160" r="3.5" fill="#60A5FA" />
        <circle cx="310" cy="285" r="3.5" fill="#A78BFA" />
      </svg>

      {/* Top System Architecture Strip */}
      <div className="relative z-10 flex items-center justify-between gap-3 border-b border-slate-700/50 pb-4">
        <div className="flex items-center gap-2.5">
          <GrantlyLogoMark size={28} />
          <div>
            <p className="text-xs font-semibold text-slate-100 font-display">
              Scholarship Intelligence Pipeline
            </p>
            <p className="text-[11px] text-slate-400">
              Deterministic Rule Engine + Gemini Multimodal Vault
            </p>
          </div>
        </div>
        <span className="text-[11px] font-mono-num text-indigo-300 px-2.5 py-1 rounded-md bg-indigo-500/15 border border-indigo-400/25">
          4-Stage Check
        </span>
      </div>

      {/* Central Interactive Intelligence Cards */}
      <div className="relative z-10 grid sm:grid-cols-2 gap-3.5 my-5">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.1 }}
          className="rounded-xl bg-[#070D1D]/90 border border-slate-700/60 p-4 space-y-2.5"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-indigo-300 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              Rule Engine
            </span>
            <span className="text-[11px] font-mono-num text-slate-400">Versioned</span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            Checks domicile state, category, academic percentage, and family income ceilings with criterion-by-criterion proof.
          </p>
          <div className="pt-1 grid grid-cols-3 gap-1.5 text-[10px] font-mono-num">
            <div className="px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-center">
              State
            </div>
            <div className="px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-center">
              Income
            </div>
            <div className="px-2 py-1 rounded bg-indigo-500/10 border border-indigo-500/25 text-indigo-300 text-center">
              Marks
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.2 }}
          className="rounded-xl bg-[#070D1D]/90 border border-slate-700/60 p-4 space-y-2.5"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-blue-300 flex items-center gap-1.5">
              <FileSearch className="w-3.5 h-3.5 text-blue-400" />
              Document Vault
            </span>
            <span className="text-[11px] font-mono-num text-slate-400">CBSE / Income</span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            Separates main 5 subjects from additional subjects and labels Document-Extracted vs AI-Calculated totals transparently.
          </p>
          <div className="pt-1 flex items-center justify-between text-[10px] font-mono-num text-slate-400 border-t border-slate-800">
            <span>OCR + Vision</span>
            <span className="text-blue-300">Private Storage</span>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.3 }}
          className="rounded-xl bg-[#070D1D]/90 border border-slate-700/60 p-4 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              TrustGuard Audit
            </span>
            <span className="text-[11px] font-mono-num text-slate-400">Risk Check</span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            Cross-checks uploaded documents against your profile and flags suspicious links or upfront fee demands.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.4 }}
          className="rounded-xl bg-[#070D1D]/90 border border-slate-700/60 p-4 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-violet-300 flex items-center gap-1.5">
              <Award className="w-3.5 h-3.5 text-violet-400" />
              Readiness &amp; Tracker
            </span>
            <span className="text-[11px] font-mono-num text-slate-400">11 Stages</span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            Computes dimension-weighted readiness, tracks deadlines in IST, and records official portal handoff.
          </p>
        </motion.div>
      </div>

      {/* Bottom Integrity Guarantee Strip */}
      <div className="relative z-10 rounded-xl bg-indigo-950/50 border border-indigo-500/25 px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-slate-200 font-medium">
          Every scheme links directly to its issuing government or institutional portal.
        </span>
        <span className="text-indigo-300 font-mono-num text-[11px]">
          Zero Auto-Submit Claims
        </span>
      </div>
    </div>
  );
}
