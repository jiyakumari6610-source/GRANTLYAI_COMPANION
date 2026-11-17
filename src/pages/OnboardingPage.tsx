import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2 } from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import { PageTransition } from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { saveProfile } from '../lib/firestoreRepo.ts';
import {
  INDIAN_STATES_AND_UTS,
  STANDARD_CERTIFICATES,
  type CategoryOption,
  type DisabilityOption,
  type EducationLevelOption,
  type GenderOption,
  type HostelOption,
  type StudentProfile,
} from '../types/database.ts';

export default function OnboardingPage() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [state, setState] = useState('');
  const [district, setDistrict] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [gender, setGender] = useState<GenderOption>('Female');
  const [category, setCategory] = useState<CategoryOption>('General');
  const [disabilityStatus, setDisabilityStatus] = useState<DisabilityOption>('None');
  const [disabilityDetails, setDisabilityDetails] = useState('');

  const [educationLevel, setEducationLevel] = useState<EducationLevelOption>('Undergraduate (UG)');
  const [courseSpecialization, setCourseSpecialization] = useState('');
  const [institutionName, setInstitutionName] = useState('');
  const [collegeLocation, setCollegeLocation] = useState('');
  const [academicYear, setAcademicYear] = useState('2026-27');
  const [currentSemesterOrYear, setCurrentSemesterOrYear] = useState('');
  const [previousMarksPercent, setPreviousMarksPercent] = useState('');

  const [familyAnnualIncomeInr, setFamilyAnnualIncomeInr] = useState('');
  const [parentOccupation, setParentOccupation] = useState('');
  const [hostelStatus, setHostelStatus] = useState<HostelOption>('Day Scholar');
  const [certificates, setCertificates] = useState<string[]>([]);

  useEffect(() => {
    if (profile) {
      setFullName(profile.fullName || user?.displayName || '');
      setEmail(profile.email || user?.email || '');
      setPhone(profile.phone || '');
      setState(profile.state || '');
      setDistrict(profile.district || '');
      setDateOfBirth(profile.dateOfBirth || '');
      if (profile.gender) setGender(profile.gender);
      if (profile.category) setCategory(profile.category);
      if (profile.disabilityStatus) setDisabilityStatus(profile.disabilityStatus);
      setDisabilityDetails(profile.disabilityDetails || '');
      if (profile.educationLevel) setEducationLevel(profile.educationLevel);
      setCourseSpecialization(profile.courseSpecialization || '');
      setInstitutionName(profile.institutionName || '');
      setCollegeLocation(profile.collegeLocation || '');
      setAcademicYear(profile.academicYear || '2026-27');
      setCurrentSemesterOrYear(profile.currentSemesterOrYear || '');
      setPreviousMarksPercent(
        typeof profile.previousMarksPercent === 'number' ? String(profile.previousMarksPercent) : ''
      );
      setFamilyAnnualIncomeInr(
        typeof profile.familyAnnualIncomeInr === 'number' ? String(profile.familyAnnualIncomeInr) : ''
      );
      setParentOccupation(profile.parentOccupation || '');
      if (profile.hostelStatus) setHostelStatus(profile.hostelStatus);
      setCertificates(profile.certificates || []);
    } else if (user) {
      setFullName(user.displayName || '');
      setEmail(user.email || '');
    }
  }, [profile, user]);

  const toggleCertificate = (cert: string) => {
    setCertificates((prev) =>
      prev.includes(cert) ? prev.filter((item) => item !== cert) : [...prev, cert]
    );
  };

  const validateStep = (): boolean => {
    setError(null);
    if (step === 1) {
      if (!fullName.trim() || !email.trim() || !phone.trim() || !state || !district.trim() || !dateOfBirth) {
        setError('Please complete all required personal, state, district, and contact fields.');
        return false;
      }
    }
    if (step === 2) {
      if (
        !courseSpecialization.trim() ||
        !institutionName.trim() ||
        !collegeLocation.trim() ||
        !academicYear.trim() ||
        !currentSemesterOrYear.trim()
      ) {
        setError('Please complete your current course, institution, location, academic year, and semester/year.');
        return false;
      }
      const marks = Number(previousMarksPercent);
      if (!previousMarksPercent || Number.isNaN(marks) || marks < 0 || marks > 100) {
        setError('Please enter valid previous academic marks percentage (0 to 100).');
        return false;
      }
    }
    if (step === 3) {
      const income = Number(familyAnnualIncomeInr);
      if (!familyAnnualIncomeInr || Number.isNaN(income) || income < 0) {
        setError('Please enter a valid family annual income in INR.');
        return false;
      }
      if (!parentOccupation.trim()) {
        setError("Please enter your father's or mother's occupation.");
        return false;
      }
    }
    return true;
  };

  const handleNext = () => {
    if (validateStep()) {
      setStep((prev) => (prev === 1 ? 2 : 3));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateStep() || !user) return;

    setSaving(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const updatedProfile: StudentProfile = {
        uid: user.uid,
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        state,
        district: district.trim(),
        dateOfBirth,
        gender,
        category,
        disabilityStatus,
        disabilityDetails: disabilityStatus === 'None' ? '' : disabilityDetails.trim(),
        educationLevel,
        courseSpecialization: courseSpecialization.trim(),
        institutionName: institutionName.trim(),
        collegeLocation: collegeLocation.trim(),
        academicYear: academicYear.trim(),
        currentSemesterOrYear: currentSemesterOrYear.trim(),
        previousMarksPercent: Number(previousMarksPercent),
        familyAnnualIncomeInr: Number(familyAnnualIncomeInr),
        parentOccupation: parentOccupation.trim(),
        hostelStatus,
        certificates,
        onboardingCompleted: true,
        createdAt: profile?.createdAt || now,
        updatedAt: now,
      };
      await saveProfile(updatedProfile);
      await refreshProfile();
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save onboarding details.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell
      title="Student Onboarding"
      breadcrumb="Workspace / Onboarding"
    >
      <PageTransition className="max-w-3xl mx-auto space-y-6">
        {/* Progress Stepper */}
        <div className="surface-card rounded-2xl p-4 sm:p-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { id: 1, label: '01. Personal & Domicile' },
              { id: 2, label: '02. Academic Record' },
              { id: 3, label: '03. Income & Certificates' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setStep(item.id as 1 | 2 | 3)}
                className={`text-left p-3.5 rounded-xl border text-xs sm:text-sm font-medium transition-all ${
                  step === item.id
                    ? 'bg-indigo-500/20 border-indigo-400/50 text-white shadow-sm'
                    : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:bg-slate-800/70 hover:text-slate-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="surface-elevated rounded-2xl p-6 sm:p-8 space-y-6">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-sm text-rose-200 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-lg font-semibold text-white font-display">Personal, Domicile &amp; Category</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Saved once to power automatic eligibility checks across Central and State schemes.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Full Name *</label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Email Address *</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Phone Number *</label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+91 98XXXXXXXX"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Date of Birth *</label>
                  <input
                    type="date"
                    value={dateOfBirth}
                    onChange={(e) => setDateOfBirth(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Domicile State / UT *</label>
                  <select
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  >
                    <option value="">Select state or UT</option>
                    {INDIAN_STATES_AND_UTS.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">District *</label>
                  <input
                    type="text"
                    value={district}
                    onChange={(e) => setDistrict(e.target.value)}
                    placeholder="e.g. Pune, Kolkata, Jaipur"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Gender *</label>
                  <select
                    value={gender}
                    onChange={(e) => setGender(e.target.value as GenderOption)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  >
                    <option value="Female">Female</option>
                    <option value="Male">Male</option>
                    <option value="Non-Binary">Non-Binary</option>
                    <option value="Prefer not to say">Prefer not to say</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Social Category *</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as CategoryOption)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  >
                    <option value="General">General</option>
                    <option value="OBC-NCL">OBC-NCL</option>
                    <option value="SC">SC</option>
                    <option value="ST">ST</option>
                    <option value="EWS">EWS</option>
                    <option value="Minority">Minority</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Disability Status *</label>
                  <select
                    value={disabilityStatus}
                    onChange={(e) => setDisabilityStatus(e.target.value as DisabilityOption)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  >
                    <option value="None">None</option>
                    <option value="PwD (40% or above)">PwD (40% or above)</option>
                    <option value="PwD (Below 40%)">PwD (Below 40%)</option>
                  </select>
                </div>
                {disabilityStatus !== 'None' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Disability Type / UDID Notes
                    </label>
                    <input
                      type="text"
                      value={disabilityDetails}
                      onChange={(e) => setDisabilityDetails(e.target.value)}
                      placeholder="Optional specification & percentage"
                      className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-lg font-semibold text-white font-display">Academic Details</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Used to match AICTE, UGC, DST INSPIRE, and degree-specific eligibility rules.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Current Education Level *</label>
                  <select
                    value={educationLevel}
                    onChange={(e) => setEducationLevel(e.target.value as EducationLevelOption)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  >
                    <option value="Class 11-12">Class 11-12</option>
                    <option value="Diploma / Polytechnic">Diploma / Polytechnic</option>
                    <option value="Undergraduate (UG)">Undergraduate (UG)</option>
                    <option value="Postgraduate (PG)">Postgraduate (PG)</option>
                    <option value="PhD / Doctoral">PhD / Doctoral</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Course &amp; Specialization *
                  </label>
                  <input
                    type="text"
                    value={courseSpecialization}
                    onChange={(e) => setCourseSpecialization(e.target.value)}
                    placeholder="e.g. B.Tech Computer Science, B.Sc Physics"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Institution Name *</label>
                  <input
                    type="text"
                    value={institutionName}
                    onChange={(e) => setInstitutionName(e.target.value)}
                    placeholder="Full college / school / university name"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">College Location *</label>
                  <input
                    type="text"
                    value={collegeLocation}
                    onChange={(e) => setCollegeLocation(e.target.value)}
                    placeholder="City & State of institution"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Academic Year *</label>
                  <input
                    type="text"
                    value={academicYear}
                    onChange={(e) => setAcademicYear(e.target.value)}
                    placeholder="e.g. 2026-27"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Current Semester / Year *</label>
                  <input
                    type="text"
                    value={currentSemesterOrYear}
                    onChange={(e) => setCurrentSemesterOrYear(e.target.value)}
                    placeholder="e.g. 1st Year / Semester 2"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Previous Qualifying Exam Marks (%) *
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={previousMarksPercent}
                    onChange={(e) => setPreviousMarksPercent(e.target.value)}
                    placeholder="e.g. 86.5 (if CGPA, enter equivalent percentage)"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight font-mono-num"
                  />
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-lg font-semibold text-white font-display">
                  Family Income, Accommodation &amp; Certificates
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Determines need-based ceiling checks, hostel allowances, and document readiness.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Family Annual Income (INR ₹) *
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={familyAnnualIncomeInr}
                    onChange={(e) => setFamilyAnnualIncomeInr(e.target.value)}
                    placeholder="e.g. 320000"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Father&apos;s / Mother&apos;s Occupation *
                  </label>
                  <input
                    type="text"
                    value={parentOccupation}
                    onChange={(e) => setParentOccupation(e.target.value)}
                    placeholder="e.g. Agriculture, Small Business, Teacher"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Hostel / Day Scholar Status *
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {(['Hosteller', 'Day Scholar'] as HostelOption[]).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setHostelStatus(opt)}
                        className={`px-4 py-2.5 rounded-xl border text-sm font-medium transition-all ${
                          hostelStatus === opt
                            ? 'bg-indigo-500/20 border-indigo-400 text-white'
                            : 'bg-slate-900/60 border-slate-700 text-slate-300 hover:bg-slate-800'
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-2.5">
                <label className="block text-xs font-medium text-slate-300">
                  Relevant Certificates Currently Held
                </label>
                <div className="grid sm:grid-cols-2 gap-2.5">
                  {STANDARD_CERTIFICATES.map((cert) => {
                    const checked = certificates.includes(cert);
                    return (
                      <label
                        key={cert}
                        className={`flex items-center gap-2.5 p-3 rounded-xl border text-xs sm:text-sm cursor-pointer transition-colors ${
                          checked
                            ? 'bg-indigo-500/15 border-indigo-400/40 text-indigo-100'
                            : 'bg-slate-900/50 border-slate-800 text-slate-300 hover:bg-slate-800/70'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCertificate(cert)}
                          className="rounded border-slate-600 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                        />
                        <span>{cert}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-slate-800 flex items-center justify-between gap-4">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => setStep((prev) => (prev === 3 ? 2 : 1))}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-200 bg-slate-900/80 border border-slate-700 hover:bg-slate-800 rounded-xl"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Previous</span>
              </button>
            ) : (
              <div />
            )}

            {step < 3 ? (
              <button
                type="button"
                onClick={handleNext}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold btn-primary-gradient rounded-xl"
              >
                <span>Continue</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 px-6 py-2.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-xl disabled:opacity-60 shadow-lg shadow-emerald-950/50"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>{saving ? 'Saving Profile...' : 'Save & Open Dashboard'}</span>
              </button>
            )}
          </div>
        </form>
      </PageTransition>
    </AppShell>
  );
}
