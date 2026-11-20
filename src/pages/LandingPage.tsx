import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowRight,
  Award,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  FileSearch,
  Lock,
  MessageSquare,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { GrantlyLogoMark, HeroIntelligenceVisual } from '../components/ui/BrandGraphics.tsx';
import { RevealSection } from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { getScholarships } from '../lib/firestoreRepo.ts';
import type { Scholarship } from '../types/database.ts';

const WORKFLOW_STEPS = [
  {
    step: '01',
    title: 'Unified Student Profile',
    description:
      'Record domicile state, category, family income, academic percentage, and held certificates once across Central and State workflows.',
  },
  {
    step: '02',
    title: 'Explainable Rule Audit',
    description:
      'Run deterministic criterion-by-criterion eligibility checks backed by Gemini explanations and saved audit snapshots.',
  },
  {
    step: '03',
    title: 'Document & TrustGuard Check',
    description:
      'Analyze marksheets and certificates with AI, separate CBSE main vs additional subjects, and catch cross-document mismatches early.',
  },
  {
    step: '04',
    title: 'Guided Application Tracking',
    description:
      'Monitor Readiness scores, IST deadlines, document checklists, and official portal handoffs from preparation to outcome.',
  },
];

const FAQ_ITEMS = [
  {
    q: 'Does GRANTLY AI submit scholarship applications on my behalf?',
    a: 'No. GRANTLY AI prepares your eligibility audit, document consistency checks, readiness roadmap, and application checklist, then links directly to the official government or institutional portal where you complete final submission yourself.',
  },
  {
    q: 'How does CBSE & academic marksheet calculation handle additional subjects?',
    a: 'Document Intelligence extracts subject-wise theory, internal assessment, and total marks individually, separates main subjects from additional subjects, and distinguishes Document-Extracted totals from AI-Calculated aggregates.',
  },
  {
    q: 'Does TrustGuard certify that a document is legally authentic or government-verified?',
    a: 'No. TrustGuard is an applicant assistance and consistency engine. It compares uploaded documents against your profile and scholarship requirements to highlight readability or data mismatches before you apply, without claiming legal certification.',
  },
  {
    q: 'Are listed scholarships verified with official links?',
    a: 'Yes. Every published scheme cites its official application portal URL and verification status maintained under role-based Admin Control Center governance.',
  },
];

export default function LandingPage() {
  const { user } = useAuth();
  const [featuredScholarships, setFeaturedScholarships] = useState<Scholarship[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(0);
  const [docImageError, setDocImageError] = useState(false);

  useEffect(() => {
    let active = true;
    getScholarships()
      .then((res) => {
        if (active) setFeaturedScholarships(res.items.slice(0, 3));
      })
      .catch(() => {
        if (active) setFeaturedScholarships([]);
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#050914] text-slate-100 flex flex-col ambient-mesh">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:px-4 focus:py-2 focus:rounded-xl focus:bg-indigo-600 focus:text-white focus:text-xs focus:font-semibold"
      >
        Skip to main content
      </a>
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="glass-surface border-x-0 border-t-0 border-b border-slate-800/80 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-6">
          <Link
            to="/"
            className="inline-flex items-center gap-2.5 text-base sm:text-lg font-bold tracking-tight text-white font-display whitespace-nowrap shrink-0"
          >
            <GrantlyLogoMark size={28} />
            <span>GRANTLY AI</span>
          </Link>

          <nav
            className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-300"
            aria-label="Main navigation"
          >
            <a href="#workflow" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              How It Works
            </a>
            <a href="#capabilities" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Platform
            </a>
            <a href="#catalogue" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Scholarships
            </a>
            <a href="#faq" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              FAQ
            </a>
            <Link to="/login" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Sign In
            </Link>
          </nav>

          <div className="shrink-0">
            <Link
              to={user ? '/dashboard' : '/register'}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold btn-primary-gradient rounded-xl whitespace-nowrap shrink-0"
            >
              <span>{user ? 'Open Dashboard' : 'Get Started'}</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
        {/* Hero Split Section */}
        <section className="relative max-w-7xl mx-auto px-4 sm:px-6 pt-10 pb-16 lg:pt-16 lg:pb-24 grid-pattern-subtle">
          <div className="grid lg:grid-cols-12 gap-10 lg:gap-12 items-stretch">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              className="lg:col-span-6 flex flex-col justify-center space-y-6"
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
                Scholarship Intelligence for Indian Students
              </p>

              <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-white leading-[1.1] text-balance font-display">
                Discover verified scholarships and check real eligibility before you apply.
              </h1>

              <p className="text-base sm:text-lg text-slate-300 leading-relaxed max-w-xl">
                Built for Class 11–12, Diploma, UG, PG, and PhD students across India. Match against Central, State, AICTE, UGC, and Foundation schemes, audit documents with AI, and verify portal authenticity.
              </p>

              <div className="flex flex-wrap items-center gap-3.5 pt-1">
                <Link
                  to={user ? '/dashboard' : '/register'}
                  className="inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold btn-primary-gradient rounded-xl whitespace-nowrap"
                >
                  <span>{user ? 'Go to Student Workspace' : 'Create Student Account'}</span>
                  <ArrowRight className="w-4 h-4" />
                </Link>
                <Link
                  to={user ? '/scholarships' : '/login'}
                  className="inline-flex items-center gap-2 px-5 py-3 text-sm font-medium text-slate-200 bg-slate-900/80 border border-slate-700/80 hover:border-indigo-400/50 hover:bg-slate-800/80 rounded-xl transition-all whitespace-nowrap"
                >
                  <span>{user ? 'Browse Verified Schemes' : 'Sign In to Continue'}</span>
                </Link>
              </div>

              <div className="pt-5 border-t border-slate-800/90 grid grid-cols-3 gap-4 max-w-lg">
                <div>
                  <p className="text-xl sm:text-2xl font-bold text-white font-mono-num">36</p>
                  <p className="text-xs text-slate-400">States &amp; UTs Supported</p>
                </div>
                <div>
                  <p className="text-xl sm:text-2xl font-bold text-white font-mono-num">19</p>
                  <p className="text-xs text-slate-400">Structured Profile Signals</p>
                </div>
                <div>
                  <p className="text-xl sm:text-2xl font-bold text-indigo-300 font-mono-num">100%</p>
                  <p className="text-xs text-slate-400">Official Portal Attribution</p>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
              className="lg:col-span-6"
            >
              <HeroIntelligenceVisual />
            </motion.div>
          </div>
        </section>

        {/* How GRANTLY AI Works */}
        <section id="workflow" className="border-y border-slate-800/80 bg-[#070C1B]/80 py-16 lg:py-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-10">
            <RevealSection className="max-w-2xl space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
                End-to-End Student Workflow
              </p>
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-display text-balance">
                Four structured stages from discovery to verified portal submission
              </h2>
            </RevealSection>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {WORKFLOW_STEPS.map((item, idx) => (
                <RevealSection key={item.step} delay={idx * 0.05}>
                  <div className="h-full surface-card surface-interactive rounded-2xl p-6 space-y-3">
                    <span className="text-xs font-mono-num font-semibold text-indigo-300">
                      Step {item.step}
                    </span>
                    <h3 className="text-base font-semibold text-white font-display">
                      {item.title}
                    </h3>
                    <p className="text-sm text-slate-400 leading-relaxed">{item.description}</p>
                  </div>
                </RevealSection>
              ))}
            </div>
          </div>
        </section>

        {/* Capabilities Bento Section */}
        <section id="capabilities" className="py-16 lg:py-22">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-10">
            <RevealSection className="max-w-2xl space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
                Platform Architecture
              </p>
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-display text-balance">
                Every decision grounded in your real profile, documents, and scheme rules.
              </h2>
            </RevealSection>

            <div className="grid lg:grid-cols-12 gap-6">
              <RevealSection className="lg:col-span-7">
                <div className="h-full surface-elevated rounded-2xl p-6 sm:p-8 flex flex-col justify-between gap-6">
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-xs font-medium text-indigo-300">
                      <span>01. Explainable Eligibility</span>
                      <span aria-hidden="true">·</span>
                      <span>Rule-by-Rule Audit</span>
                    </div>
                    <h3 className="text-xl font-semibold text-white font-display">
                      Understand exactly why you qualify or what threshold is missing
                    </h3>
                    <p className="text-sm text-slate-300 leading-relaxed max-w-xl">
                      Instead of vague compatibility scores, GRANTLY AI checks your reported family annual income, domicile state, social category, academic marks, and course level against versioned scheme criteria before generating an explainable Gemini breakdown.
                    </p>
                  </div>

                  <div className="grid sm:grid-cols-3 gap-3.5 pt-4 border-t border-slate-800">
                    <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                      <p className="text-[11px] text-slate-400">Pass / Fail Proof</p>
                      <p className="text-sm font-semibold text-white mt-1">Deterministic Audit</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                      <p className="text-[11px] text-slate-400">Missing Data</p>
                      <p className="text-sm font-semibold text-white mt-1">Inline Profile Fix</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                      <p className="text-[11px] text-slate-400">Rule Provenance</p>
                      <p className="text-sm font-semibold text-white mt-1">Saved Audit History</p>
                    </div>
                  </div>
                </div>
              </RevealSection>

              <RevealSection className="lg:col-span-5" delay={0.05}>
                <div className="h-full surface-card rounded-2xl overflow-hidden flex flex-col">
                  <div className="h-48 relative overflow-hidden border-b border-slate-800 bg-[#070D1D]">
                    {!docImageError ? (
                      <img
                        src="/images/document-intelligence-desk.jpg"
                        alt="Academic marksheets and verification documents organized on a study desk"
                        onError={() => setDocImageError(true)}
                        className="w-full h-full object-cover opacity-90"
                      />
                    ) : (
                      <div
                        role="img"
                        aria-label="Academic marksheets and verification documents organized on a study desk"
                        className="w-full h-full flex flex-col items-center justify-center gap-2.5 bg-gradient-to-br from-[#0B1329] via-[#0E1835] to-[#070C1B] px-6 text-center"
                      >
                        <div className="w-11 h-11 rounded-xl bg-blue-500/15 border border-blue-400/30 flex items-center justify-center text-blue-300">
                          <FileSearch className="w-5 h-5" />
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-xs font-semibold text-slate-200 font-display">
                            Academic Document Vault
                          </p>
                          <p className="text-[11px] text-slate-400">
                            Marksheets · Income &amp; Category Certificates
                          </p>
                        </div>
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-[#0B1224] via-transparent to-transparent pointer-events-none" />
                  </div>
                  <div className="p-6 space-y-2.5 flex-1">
                    <div className="flex items-center gap-2 text-xs font-medium text-blue-300">
                      <span>02. Document Intelligence</span>
                      <span aria-hidden="true">·</span>
                      <span>Gemini Multimodal</span>
                    </div>
                    <h3 className="text-lg font-semibold text-white font-display">
                      Pre-verify marksheets, income &amp; caste certificates
                    </h3>
                    <p className="text-sm text-slate-400 leading-relaxed">
                      Inspect document requirements per scholarship, review marksheet calculation rules, and cross-check required certificates (new file uploads are paused during public beta).
                    </p>
                  </div>
                </div>
              </RevealSection>

              <RevealSection className="lg:col-span-4" delay={0.06}>
                <div className="h-full surface-card surface-interactive rounded-2xl p-6 space-y-3">
                  <Award className="w-5 h-5 text-indigo-400" />
                  <h3 className="text-base font-semibold text-white font-display">
                    03. Scholarship Readiness
                  </h3>
                  <p className="text-sm text-slate-400 leading-relaxed">
                    Evaluate readiness across profile completeness, eligibility standing, verified document coverage, and TrustGuard consistency with prioritized action plans.
                  </p>
                </div>
              </RevealSection>

              <RevealSection className="lg:col-span-4" delay={0.1}>
                <div className="h-full surface-card surface-interactive rounded-2xl p-6 space-y-3">
                  <MessageSquare className="w-5 h-5 text-blue-400" />
                  <h3 className="text-base font-semibold text-white font-display">
                    04. AI Scholarship Companion
                  </h3>
                  <p className="text-sm text-slate-400 leading-relaxed">
                    Ask profile-aware questions grounded in your saved marksheets, eligibility checks, and tracked applications—including Aadhaar-NPCI seeding and Tehsildar validity rules.
                  </p>
                </div>
              </RevealSection>

              <RevealSection className="lg:col-span-4" delay={0.14}>
                <div className="h-full surface-card surface-interactive rounded-2xl p-6 space-y-3">
                  <ClipboardCheck className="w-5 h-5 text-violet-400" />
                  <h3 className="text-base font-semibold text-white font-display">
                    05. Application Tracker
                  </h3>
                  <p className="text-sm text-slate-400 leading-relaxed">
                    Manage applications through validated workflow stages, IST deadline alerts, per-scheme document checklists, and safe official portal visit logs.
                  </p>
                </div>
              </RevealSection>
            </div>
          </div>
        </section>

        {/* Verified Reference Catalog Preview */}
        <section id="catalogue" className="border-t border-slate-800/80 bg-[#070C1B]/60 py-16 lg:py-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-8">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div className="space-y-2 max-w-2xl">
                <p className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
                  Verified Public Schemes
                </p>
                <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-display">
                  Transparent scholarship records with official portal links
                </h2>
              </div>
              <Link
                to={user ? '/scholarships' : '/register'}
                className="text-sm font-semibold text-indigo-300 hover:text-indigo-200 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <span>Explore full catalogue</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>

            {catalogLoading ? (
              <div className="grid md:grid-cols-3 gap-6">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="h-56 rounded-2xl border border-slate-800 skeleton-shimmer" />
                ))}
              </div>
            ) : featuredScholarships.length === 0 ? (
              <div className="surface-card rounded-2xl p-8 text-center space-y-2">
                <p className="text-sm font-semibold text-white">
                  No verified scholarship records published in the database yet
                </p>
                <p className="text-xs text-slate-400">
                  Verified NSP, AICTE, UGC, State DBT, and foundation records are currently updating. Please check back shortly.
                </p>
              </div>
            ) : (
              <div className="grid md:grid-cols-3 gap-6">
                {featuredScholarships.map((item) => (
                  <div
                    key={item.id}
                    className="surface-card surface-interactive rounded-2xl p-6 flex flex-col justify-between gap-5"
                  >
                    <div className="space-y-3">
                      <div className="text-xs text-slate-400 flex items-center gap-2">
                        <span>{item.scholarshipType}</span>
                        <span aria-hidden="true">·</span>
                        <span className="text-emerald-400 font-medium">{item.verificationStatus}</span>
                      </div>
                      <h3 className="text-base font-semibold text-white leading-snug font-display">
                        {item.title}
                      </h3>
                      <p className="text-xs text-slate-400">{item.provider}</p>
                      <p className="text-sm text-slate-300 leading-relaxed line-clamp-3">
                        {item.financialBenefitsText || item.benefitsSummary || item.description}
                      </p>
                    </div>
                    <div className="pt-4 border-t border-slate-800 flex items-center justify-between text-xs">
                      <span className="font-mono-num font-semibold text-indigo-200">
                        {item.annualAwardInr ? `₹${item.annualAwardInr.toLocaleString('en-IN')}/yr` : 'Variable Grant'}
                      </span>
                      <Link
                        to={user ? `/scholarships/${item.id}` : '/register'}
                        className="font-medium text-indigo-300 hover:text-indigo-200 hover:underline"
                      >
                        View criteria →
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* TrustGuard & Platform Integrity Section */}
        <section id="trustguard" className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
          <div className="surface-elevated rounded-2xl p-7 sm:p-10 grid lg:grid-cols-12 gap-8 items-center border-indigo-500/25">
            <div className="lg:col-span-8 space-y-4">
              <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-300">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>TrustGuard Verification &amp; Privacy Standard</span>
              </div>
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-display text-balance">
                Zero fabricated opportunities. Every listing cites its official application portal.
              </h2>
              <p className="text-sm sm:text-base text-slate-300 leading-relaxed max-w-2xl">
                Legitimate Central and State scholarship portals never ask students for registration fees, UPI transfers, or bank OTPs. Use TrustGuard inside your workspace to cross-check document consistency and inspect suspicious links safely.
              </p>
              <div className="flex flex-wrap items-center gap-6 pt-1 text-xs text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-indigo-400" />
                  UID-Isolated Student Workspace
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  Server-Verified Admin Governance
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                  Transparent AI vs Document Labels
                </span>
              </div>
            </div>
            <div className="lg:col-span-4 flex lg:justify-end">
              <Link
                to={user ? '/trustguard' : '/register'}
                className="inline-flex items-center gap-2 px-5 py-3 text-sm font-semibold btn-primary-gradient rounded-xl whitespace-nowrap"
              >
                <span>Open TrustGuard</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </section>

        {/* Interactive FAQ Accordion */}
        <section id="faq" className="max-w-4xl mx-auto px-4 sm:px-6 pb-20 space-y-6">
          <div className="text-center space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
              Platform Clarity
            </p>
            <h2 className="text-2xl sm:text-3xl font-bold text-white font-display">
              Frequently Asked Questions
            </h2>
          </div>

          <div className="space-y-3">
            {FAQ_ITEMS.map((item, index) => {
              const isOpen = openFaqIndex === index;
              return (
                <div key={item.q} className="surface-card rounded-2xl overflow-hidden">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpenFaqIndex(isOpen ? null : index)}
                    className="w-full px-6 py-4 text-left flex items-center justify-between gap-4 text-sm font-semibold text-white hover:bg-slate-800/40 transition-colors"
                  >
                    <span>{item.q}</span>
                    <ChevronDown
                      className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
                        isOpen ? 'rotate-180 text-indigo-300' : ''
                      }`}
                    />
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22 }}
                        className="overflow-hidden"
                      >
                        <p className="px-6 pb-5 text-sm text-slate-300 leading-relaxed border-t border-slate-800/70 pt-3">
                          {item.a}
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-800/90 bg-[#040710] py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-400">
          <div className="flex items-center gap-2.5">
            <GrantlyLogoMark size={22} />
            <span>GRANTLY AI — Scholarship Intelligence Platform (Public Beta)</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-5">
            <Link to="/privacy" className="hover:text-white transition-colors">
              Privacy Policy
            </Link>
            <Link to="/terms" className="hover:text-white transition-colors">
              Terms of Service
            </Link>
            <Link to="/support" className="hover:text-white transition-colors">
              Support &amp; Grievance
            </Link>
            <Link to="/login" className="hover:text-white transition-colors">
              Student Login
            </Link>
            <Link to="/register" className="hover:text-white transition-colors">
              Registration
            </Link>
            <Link to="/admin/login" className="hover:text-white transition-colors">
              Admin Portal
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
