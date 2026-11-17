import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import type { NextFunction, Request, Response } from 'express';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };
import { isPrivilegedRole, isSuperAdminRole, normalizeAppRole } from '../lib/adminGovernanceEngine.ts';
import type { UserRoleRecord } from '../types/database.ts';

if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

export const adminAuth = getAuth();
export const BOOTSTRAP_ADMIN_EMAIL = 'jiyakumari2480@gmail.com';

export interface AuthenticatedRequest extends Request {
  user?: DecodedIdToken;
  idToken?: string;
  adminRole?: 'student' | 'admin' | 'super_admin';
}

export async function resolveServerRoleForUser(params: {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  idToken: string;
}): Promise<{
  role: 'student' | 'admin' | 'super_admin';
  status: 'active' | 'disabled';
  source: 'bootstrap' | 'user_roles' | 'default';
}> {
  const { uid, email, emailVerified, idToken } = params;

  if (!emailVerified) {
    return { role: 'student', status: 'active', source: 'default' };
  }

  if (email && email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase()) {
    return { role: 'super_admin', status: 'active', source: 'bootstrap' };
  }

  try {
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/user_roles/${encodeURIComponent(uid)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 200) {
      const json = (await res.json()) as {
        fields?: {
          role?: { stringValue?: string };
          status?: { stringValue?: string };
        };
      };
      const rawRole = json.fields?.role?.stringValue;
      const rawStatus = json.fields?.status?.stringValue === 'disabled' ? 'disabled' : 'active';
      const normalized = normalizeAppRole(rawRole as UserRoleRecord['role']);
      return {
        role: rawStatus === 'disabled' ? 'student' : normalized,
        status: rawStatus,
        source: 'user_roles',
      };
    }
  } catch (error) {
    console.error('Server role lookup failed:', error);
  }

  return { role: 'student', status: 'active', source: 'default' };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Please sign in to continue.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Authentication token is empty.' });
    return;
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    req.user = decodedToken;
    req.idToken = token;
    next();
  } catch (error) {
    console.error('Firebase token verification error:', error);
    res.status(401).json({ error: 'Session expired or invalid authentication token.' });
  }
}

export async function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = req.user;
  const idToken = req.idToken;
  if (!user || !idToken) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  if (!user.email_verified) {
    res.status(403).json({ error: 'Forbidden: Verified email required for administrator access.' });
    return;
  }

  const resolved = await resolveServerRoleForUser({
    uid: user.uid,
    email: user.email,
    emailVerified: user.email_verified,
    idToken,
  });

  if (resolved.status === 'disabled' || !isPrivilegedRole(resolved.role, resolved.status)) {
    res.status(403).json({
      error: 'Forbidden: Administrator permissions verified in user_roles are required.',
    });
    return;
  }

  req.adminRole = resolved.role;
  next();
}

export async function requireSuperAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = req.user;
  const idToken = req.idToken;
  if (!user || !idToken) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  const resolved = await resolveServerRoleForUser({
    uid: user.uid,
    email: user.email,
    emailVerified: user.email_verified,
    idToken,
  });

  if (resolved.status === 'disabled' || !isSuperAdminRole(resolved.role, resolved.status)) {
    res.status(403).json({
      error: 'Forbidden: Super Admin privileges are required to modify user roles or RBAC permissions.',
    });
    return;
  }

  req.adminRole = 'super_admin';
  next();
}
