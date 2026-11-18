import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Save } from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import { PageTransition, SkeletonCard } from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { getNotifications, markNotificationRead, saveProfile } from '../lib/firestoreRepo.ts';
import { peekUserCache } from '../lib/workspaceCache.ts';
import {
  INDIAN_STATES_AND_UTS,
  STANDARD_CERTIFICATES,
  type CategoryOption,
  type DisabilityOption,
  type EducationLevelOption,
  type GenderOption,
  type HostelOption,
  type NotificationRecord,
  type StudentProfile,
} from '../types/database.ts';

export default function ProfilePage() {
  const { user, profile, refreshProfile } = useAuth();
  const [form, setForm] = useState<StudentProfile | null>(null);
  const [notifications, setNotifications] = useState<NotificationRecord[]>(
    () => peekUserCache<NotificationRecord[]>(user?.uid, 'notifications') ?? []
  );
  const [saving, setSaving] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setForm(profile);
    } else if (user) {
      const now = new Date().toISOString();
      setForm({
        uid: user.uid,
        fullName: user.displayName || '',
        email: user.email || '',
        onboardingCompleted: false,
        certificates: [],
        createdAt: now,
        updatedAt: now,
      });
    }
  }, [profile, user]);

  useEffect(() => {
    if (!user) return;
    getNotifications(user.uid)
      .then(setNotifications)
      .catch(() => {});
  }, [user]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !form) return;
    setError(null);
    setSavedBanner(false);
    setSaving(true);
    try {
      const updated: StudentProfile = {
        ...form,
        uid: user.uid,
        onboardingCompleted: true,
        updatedAt: new Date().toISOString(),
      };
      await saveProfile(updated);
      await refreshProfile();
      setSavedBanner(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update profile.');
    } finally {
      setSaving(false);
    }
  };

  const toggleCert = (cert: string) => {
    if (!form) return;
    const current = form.certificates ?? [];
    setForm({
      ...form,
      certificates: current.includes(cert) ? current.filter((c) => c !== cert) : [...current, cert],
    });
  };

  if (!form) {
    return (
      <AppShell title="Student Profile" breadcrumb="Workspace / Profile">
        <SkeletonCard className="h-72" />
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Student Profile"
      breadcrumb="Workspace / Profile"
    >
      <PageTransition className="space-y-6">
        <form onSubmit={handleSave} className="surface-card rounded-2xl p-6 sm:p-8 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <h2 className="text-base font-semibold text-white font-display">
                Unified Student Record
              </h2>
              <p className="text-xs text-slate-400">
                Updates immediately reflect in Eligibility Checker, Readiness, and AI Companion.
              </p>
            </div>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold btn-primary-gradient rounded-xl disabled:opacity-60"
            >
              <Save className="w-4 h-4" />
              <span>{saving ? 'Saving...' : 'Save Changes'}</span>
            </button>
          </div>

          {error && (
            <div className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-sm text-rose-200 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {savedBanner && (
            <div className="p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-sm text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Profile updated in database.</span>
            </div>
          )}

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Full Name</label>
              <input
                type="text"
                required
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Email</label>
              <input
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Phone Number</label>
              <input
                type="tel"
                value={form.phone || ''}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Domicile State</label>
              <select
                value={form.state || ''}
                onChange={(e) => setForm({ ...form, state: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              >
                <option value="">Select State</option>
                {INDIAN_STATES_AND_UTS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">District</label>
              <input
                type="text"
                value={form.district || ''}
                onChange={(e) => setForm({ ...form, district: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Date of Birth</label>
              <input
                type="date"
                value={form.dateOfBirth || ''}
                onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Gender</label>
              <select
                value={form.gender || 'Female'}
                onChange={(e) => setForm({ ...form, gender: e.target.value as GenderOption })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              >
                <option value="Female">Female</option>
                <option value="Male">Male</option>
                <option value="Non-Binary">Non-Binary</option>
                <option value="Prefer not to say">Prefer not to say</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Category</label>
              <select
                value={form.category || 'General'}
                onChange={(e) => setForm({ ...form, category: e.target.value as CategoryOption })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
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
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Disability Status</label>
              <select
                value={form.disabilityStatus || 'None'}
                onChange={(e) => setForm({ ...form, disabilityStatus: e.target.value as DisabilityOption })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              >
                <option value="None">None</option>
                <option value="PwD (40% or above)">PwD (40% or above)</option>
                <option value="PwD (Below 40%)">PwD (Below 40%)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Education Level</label>
              <select
                value={form.educationLevel || 'Undergraduate (UG)'}
                onChange={(e) => setForm({ ...form, educationLevel: e.target.value as EducationLevelOption })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              >
                <option value="Class 11-12">Class 11-12</option>
                <option value="Diploma / Polytechnic">Diploma / Polytechnic</option>
                <option value="Undergraduate (UG)">Undergraduate (UG)</option>
                <option value="Postgraduate (PG)">Postgraduate (PG)</option>
                <option value="PhD / Doctoral">PhD / Doctoral</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Course &amp; Specialization</label>
              <input
                type="text"
                value={form.courseSpecialization || ''}
                onChange={(e) => setForm({ ...form, courseSpecialization: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Institution Name</label>
              <input
                type="text"
                value={form.institutionName || ''}
                onChange={(e) => setForm({ ...form, institutionName: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">College Location</label>
              <input
                type="text"
                value={form.collegeLocation || ''}
                onChange={(e) => setForm({ ...form, collegeLocation: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Academic Year</label>
              <input
                type="text"
                value={form.academicYear || ''}
                onChange={(e) => setForm({ ...form, academicYear: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Current Semester / Year</label>
              <input
                type="text"
                value={form.currentSemesterOrYear || ''}
                onChange={(e) => setForm({ ...form, currentSemesterOrYear: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Previous Academic Marks (%)</label>
              <input
                type="number"
                step="0.1"
                value={form.previousMarksPercent ?? ''}
                onChange={(e) =>
                  setForm({ ...form, previousMarksPercent: e.target.value ? Number(e.target.value) : null })
                }
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight font-mono-num"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Family Annual Income (INR)</label>
              <input
                type="number"
                value={form.familyAnnualIncomeInr ?? ''}
                onChange={(e) =>
                  setForm({ ...form, familyAnnualIncomeInr: e.target.value ? Number(e.target.value) : null })
                }
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight font-mono-num"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Parent Occupation</label>
              <input
                type="text"
                value={form.parentOccupation || ''}
                onChange={(e) => setForm({ ...form, parentOccupation: e.target.value })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Hostel / Day Scholar</label>
              <select
                value={form.hostelStatus || 'Day Scholar'}
                onChange={(e) => setForm({ ...form, hostelStatus: e.target.value as HostelOption })}
                className="w-full px-3.5 py-2 text-sm rounded-xl input-midnight"
              >
                <option value="Hosteller">Hosteller</option>
                <option value="Day Scholar">Day Scholar</option>
              </select>
            </div>
          </div>

          <div className="space-y-2.5">
            <label className="block text-xs font-medium text-slate-300">Held Certificates</label>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              {STANDARD_CERTIFICATES.map((cert) => {
                const checked = (form.certificates ?? []).includes(cert);
                return (
                  <label
                    key={cert}
                    className={`flex items-center gap-2 p-2.5 rounded-xl border text-xs cursor-pointer transition-colors ${
                      checked
                        ? 'bg-indigo-500/15 border-indigo-400/40 text-indigo-100'
                        : 'bg-slate-900/50 border-slate-800 text-slate-300 hover:bg-slate-800/70'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCert(cert)}
                      className="rounded border-slate-600 bg-slate-900 text-indigo-500"
                    />
                    <span>{cert}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </form>

        {notifications.length > 0 && (
          <div className="surface-card rounded-2xl p-6 space-y-3">
            <h2 className="text-sm font-semibold text-white font-display">Notifications</h2>
            <div className="divide-y divide-slate-800/80">
              {notifications.map((n) => (
                <div key={n.id} className="py-3 flex items-start justify-between gap-4 text-xs">
                  <div>
                    <p className="font-semibold text-slate-100">{n.title}</p>
                    <p className="text-slate-400 mt-0.5">{n.message}</p>
                  </div>
                  {!n.isRead && (
                    <button
                      type="button"
                      onClick={() => {
                        void markNotificationRead(n.id);
                        setNotifications((prev) =>
                          prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x))
                        );
                      }}
                      className="text-indigo-300 font-medium hover:underline shrink-0"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </PageTransition>
    </AppShell>
  );
}
