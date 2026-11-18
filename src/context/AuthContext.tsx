import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import {
  auth,
  db,
  fetchFirestoreDocumentViaRest,
  googleAuthProvider,
  isFirestoreOfflineError,
  recoverFirestoreNetwork,
  testFirestoreConnection,
} from '../lib/firebase.ts';
import { isPrivilegedRole, isSuperAdminRole, normalizeAppRole } from '../lib/adminGovernanceEngine.ts';
import { getProfile, getScholarships, saveProfile, seedVerifiedScholarships } from '../lib/firestoreRepo.ts';
import { ensureCacheOwner, invalidateAllUserCaches } from '../lib/workspaceCache.ts';
import type { StudentProfile, UserRoleRecord } from '../types/database.ts';

const BOOTSTRAP_ADMIN_EMAIL = 'jiyakumari2480@gmail.com';

interface AuthContextValue {
  user: User | null;
  profile: StudentProfile | null;
  userRole: UserRoleRecord['role'];
  isAdmin: boolean;
  isSuperAdmin: boolean;
  loading: boolean;
  firestoreReachable: boolean;
  signInWithGoogle: () => Promise<User>;
  registerWithEmail: (fullName: string, email: string, password: string) => Promise<User>;
  loginWithEmail: (email: string, password: string) => Promise<User>;
  resetPassword: (email: string) => Promise<void>;
  resendVerificationEmail: () => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  getIdToken: () => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function resolveProfileForUser(firebaseUser: User): Promise<StudentProfile | null> {
  const existingProfile = await getProfile(firebaseUser.uid);
  if (existingProfile) {
    return existingProfile;
  }
  if (firebaseUser.emailVerified) {
    const now = new Date().toISOString();
    const starterProfile: StudentProfile = {
      uid: firebaseUser.uid,
      fullName: firebaseUser.displayName?.trim() || firebaseUser.email?.split('@')[0] || 'Student',
      email: firebaseUser.email ?? '',
      onboardingCompleted: false,
      certificates: [],
      createdAt: now,
      updatedAt: now,
    };
    await saveProfile(starterProfile);
    const persisted = await getProfile(firebaseUser.uid);
    return persisted ?? starterProfile;
  }
  return null;
}

async function resolveRoleForUser(firebaseUser: User): Promise<{
  role: UserRoleRecord['role'];
  status: 'active' | 'disabled';
}> {
  if (
    firebaseUser.email?.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase() &&
    firebaseUser.emailVerified
  ) {
    return { role: 'super_admin', status: 'active' };
  }

  let resolvedRole: UserRoleRecord['role'] = 'student';
  let resolvedStatus: 'active' | 'disabled' = 'active';
  try {
    const roleSnap = await getDoc(doc(db, 'user_roles', firebaseUser.uid));
    if (roleSnap.exists()) {
      const data = roleSnap.data() as UserRoleRecord;
      resolvedStatus = data.status === 'disabled' ? 'disabled' : 'active';
      resolvedRole = resolvedStatus === 'disabled' ? 'student' : normalizeAppRole(data.role);
    }
  } catch (roleErr) {
    if (isFirestoreOfflineError(roleErr)) {
      try {
        const token = await firebaseUser.getIdToken();
        const restRole = await fetchFirestoreDocumentViaRest<UserRoleRecord>(
          'user_roles',
          firebaseUser.uid,
          token
        );
        if (restRole.exists && restRole.data) {
          resolvedStatus = restRole.data.status === 'disabled' ? 'disabled' : 'active';
          resolvedRole =
            resolvedStatus === 'disabled' ? 'student' : normalizeAppRole(restRole.data.role);
        }
      } catch {
        resolvedRole = 'student';
      }
    } else {
      resolvedRole = 'student';
    }
  }
  return { role: resolvedRole, status: resolvedStatus };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [userRole, setUserRole] = useState<UserRoleRecord['role']>('student');
  const [roleStatus, setRoleStatus] = useState<'active' | 'disabled'>('active');
  const [loading, setLoading] = useState(true);
  const [firestoreReachable, setFirestoreReachable] = useState(true);
  const inFlightLoadRef = useRef<{ uid: string; promise: Promise<void> } | null>(null);

  const loadUserData = useCallback((firebaseUser: User | null): Promise<void> => {
    ensureCacheOwner(firebaseUser?.uid ?? null);

    if (!firebaseUser) {
      setProfile(null);
      setUserRole('student');
      setRoleStatus('active');
      return Promise.resolve();
    }

    if (inFlightLoadRef.current?.uid === firebaseUser.uid) {
      return inFlightLoadRef.current.promise;
    }

    const runPromise: Promise<void> = (async () => {
      try {
        const [resolvedProfile, roleInfo] = await Promise.all([
          resolveProfileForUser(firebaseUser),
          resolveRoleForUser(firebaseUser),
        ]);

        if (auth.currentUser && auth.currentUser.uid !== firebaseUser.uid) {
          return;
        }

        setFirestoreReachable(true);
        setProfile(resolvedProfile);
        setUserRole(roleInfo.role);
        setRoleStatus(roleInfo.status);

        if (
          isPrivilegedRole(roleInfo.role, roleInfo.status) &&
          firebaseUser.emailVerified &&
          typeof window !== 'undefined' &&
          !window.sessionStorage.getItem('grantly_admin_auto_synced')
        ) {
          try {
            const catalog = await getScholarships();
            if (catalog.isEmptyDatabase) {
              await seedVerifiedScholarships();
            }
            window.sessionStorage.setItem('grantly_admin_auto_synced', '1');
          } catch {
            // Best-effort sync; admin can always trigger sync manually in /admin
          }
        }
      } catch (err) {
        if (isFirestoreOfflineError(err)) {
          setFirestoreReachable(false);
          console.warn('Firestore appears temporarily offline while hydrating user profile.');
        } else {
          console.error('Error hydrating user data:', err);
        }
      } finally {
        if (inFlightLoadRef.current?.uid === firebaseUser.uid) {
          inFlightLoadRef.current = null;
        }
      }
    })();

    inFlightLoadRef.current = { uid: firebaseUser.uid, promise: runPromise };
    return runPromise;
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      ensureCacheOwner(firebaseUser?.uid ?? null);
      setUser(firebaseUser);
      await loadUserData(firebaseUser);
      setLoading(false);
    });

    return () => unsub();
  }, [loadUserData]);

  useEffect(() => {
    if (typeof window === 'undefined' || firestoreReachable || !user) return;
    const handleOnline = async () => {
      await recoverFirestoreNetwork();
      const status = await testFirestoreConnection();
      setFirestoreReachable(status.reachable);
      if (status.reachable && auth.currentUser) {
        await loadUserData(auth.currentUser);
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [firestoreReachable, user, loadUserData]);

  const signInWithGoogle = useCallback(async () => {
    const result = await signInWithPopup(auth, googleAuthProvider);
    ensureCacheOwner(result.user.uid);
    await loadUserData(result.user);
    return result.user;
  }, [loadUserData]);

  const registerWithEmail = useCallback(async (fullName: string, email: string, password: string) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    ensureCacheOwner(cred.user.uid);
    await updateProfile(cred.user, { displayName: fullName });
    try {
      await sendEmailVerification(cred.user);
    } catch {
      // Verification email dispatch is best-effort
    }
    return cred.user;
  }, []);

  const loginWithEmail = useCallback(
    async (email: string, password: string) => {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      ensureCacheOwner(cred.user.uid);
      await loadUserData(cred.user);
      return cred.user;
    },
    [loadUserData]
  );

  const resetPassword = useCallback(async (email: string) => {
    await sendPasswordResetEmail(auth, email.trim());
  }, []);

  const resendVerificationEmail = useCallback(async () => {
    if (!auth.currentUser) {
      throw new Error('No active user session found.');
    }
    await sendEmailVerification(auth.currentUser);
  }, []);

  const logout = useCallback(async () => {
    inFlightLoadRef.current = null;
    invalidateAllUserCaches(null);
    await signOut(auth);
    setUser(null);
    setProfile(null);
    setUserRole('student');
    setRoleStatus('active');
  }, []);

  const refreshProfile = useCallback(async () => {
    if (auth.currentUser) {
      await auth.currentUser.reload();
      setUser(auth.currentUser);
      await loadUserData(auth.currentUser);
    }
  }, [loadUserData]);

  const getIdToken = useCallback(async () => {
    if (!auth.currentUser) {
      throw new Error('User is not authenticated.');
    }
    return auth.currentUser.getIdToken();
  }, []);

  const isBootstrapSuperAdmin =
    Boolean(user?.emailVerified) &&
    user?.email?.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase();

  const isSuperAdmin =
    Boolean(user?.emailVerified) &&
    (isBootstrapSuperAdmin || isSuperAdminRole(userRole, roleStatus));

  const isAdmin =
    Boolean(user?.emailVerified) &&
    (isSuperAdmin || isPrivilegedRole(userRole, roleStatus));

  const effectiveRole: UserRoleRecord['role'] = isBootstrapSuperAdmin ? 'super_admin' : userRole;

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
      userRole: effectiveRole,
      isAdmin,
      isSuperAdmin,
      loading,
      firestoreReachable,
      signInWithGoogle,
      registerWithEmail,
      loginWithEmail,
      resetPassword,
      resendVerificationEmail,
      logout,
      refreshProfile,
      getIdToken,
    }),
    [
      user,
      profile,
      effectiveRole,
      isAdmin,
      isSuperAdmin,
      loading,
      firestoreReachable,
      signInWithGoogle,
      registerWithEmail,
      loginWithEmail,
      resetPassword,
      resendVerificationEmail,
      logout,
      refreshProfile,
      getIdToken,
    ]
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }
  return ctx;
}
