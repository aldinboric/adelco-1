import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { getDb, type UserRow } from './db.ts';

export type UserRole = 'admin' | 'user';

export interface UserPermissions {
  customer_quote: boolean;
  issued_quotes_view: boolean;
  issued_quotes_manage: boolean;
  products_view: boolean;
  products_manage: boolean;
  colors_view: boolean;
  colors_manage: boolean;
  exports: boolean;
  backup_settings: boolean;
}

export type PermissionKey = keyof UserPermissions;

export interface PublicAuthUser {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  permissions: UserPermissions;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export const ALL_PERMISSIONS: UserPermissions = {
  customer_quote: true,
  issued_quotes_view: true,
  issued_quotes_manage: true,
  products_view: true,
  products_manage: true,
  colors_view: true,
  colors_manage: true,
  exports: true,
  backup_settings: true,
};

export const DEFAULT_USER_PERMISSIONS: UserPermissions = {
  ...ALL_PERMISSIONS,
};

export const SESSION_COOKIE_NAME = 'adelco_session';
export const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

const USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;

// In-memory brute-force protection (sliding window)
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_USER_IP = 5;
const MAX_FAILS_PER_IP = 20;

interface AttemptRecord {
  failures: number[];
}

const attemptsByUserIp = new Map<string, AttemptRecord>();
const attemptsByIp = new Map<string, AttemptRecord>();

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  if (!USERNAME_REGEX.test(cleaned)) return null;
  return cleaned;
}

export function validatePasswordStrength(raw: unknown): { ok: true; password: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Password is required.' };
  }
  if (raw.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters long.' };
  }
  if (raw.length > 128) {
    return { ok: false, error: 'Password must be 128 characters or fewer.' };
  }
  if (raw.trim().length === 0) {
    return { ok: false, error: 'Password cannot be whitespace only.' };
  }
  return { ok: true, password: raw };
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!password || !storedHash || !storedHash.includes(':')) return false;
  const [salt, hexDigest] = storedHash.split(':');
  if (!salt || !hexDigest) return false;
  try {
    const expected = Buffer.from(hexDigest, 'hex');
    const actual = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function sanitizePermissions(input: unknown, fallback: UserPermissions = DEFAULT_USER_PERMISSIONS): UserPermissions {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const result: UserPermissions = {
    customer_quote: typeof src.customer_quote === 'boolean' ? src.customer_quote : fallback.customer_quote,
    issued_quotes_view: typeof src.issued_quotes_view === 'boolean' ? src.issued_quotes_view : fallback.issued_quotes_view,
    issued_quotes_manage: typeof src.issued_quotes_manage === 'boolean' ? src.issued_quotes_manage : fallback.issued_quotes_manage,
    products_view: typeof src.products_view === 'boolean' ? src.products_view : fallback.products_view,
    products_manage: typeof src.products_manage === 'boolean' ? src.products_manage : fallback.products_manage,
    colors_view: typeof src.colors_view === 'boolean' ? src.colors_view : fallback.colors_view,
    colors_manage: typeof src.colors_manage === 'boolean' ? src.colors_manage : fallback.colors_manage,
    exports: typeof src.exports === 'boolean' ? src.exports : fallback.exports,
    backup_settings: typeof src.backup_settings === 'boolean' ? src.backup_settings : fallback.backup_settings,
  };

  // Enforce coherent dependency: manage implies view
  if (result.issued_quotes_manage) result.issued_quotes_view = true;
  if (result.products_manage) result.products_view = true;
  if (result.colors_manage) result.colors_view = true;

  return result;
}

export function parseUserPermissions(json: string, role: UserRole): UserPermissions {
  if (role === 'admin') {
    return { ...ALL_PERMISSIONS };
  }
  try {
    const parsed = JSON.parse(json);
    return sanitizePermissions(parsed, DEFAULT_USER_PERMISSIONS);
  } catch {
    return { ...DEFAULT_USER_PERMISSIONS };
  }
}

export function toPublicAuthUser(row: UserRow): PublicAuthUser {
  const role: UserRole = row.role === 'admin' ? 'admin' : 'user';
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role,
    is_active: row.is_active === 1,
    must_change_password: row.must_change_password === 1,
    permissions: parseUserPermissions(row.permissions_json, role),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
  };
}

export function userHasPermission(user: PublicAuthUser, key: PermissionKey): boolean {
  if (!user.is_active) return false;
  if (user.role === 'admin') return true;
  return Boolean(user.permissions[key]);
}

function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function createUserSession(userId: number): { rawToken: string; expiresAt: string } {
  const db = getDb();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DURATION_MS);
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(rawToken);

  // Purge expired sessions opportunistically
  db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now.toISOString());

  db.prepare(
    'INSERT INTO user_sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tokenHash, userId, expires.toISOString(), now.toISOString(), now.toISOString());

  return { rawToken, expiresAt: expires.toISOString() };
}

export function revokeSessionByRawToken(rawToken: string): void {
  const db = getDb();
  const tokenHash = hashSessionToken(rawToken);
  db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(tokenHash);
}

export function revokeUserSessions(userId: number, exceptRawToken?: string): void {
  const db = getDb();
  if (exceptRawToken) {
    const keepHash = hashSessionToken(exceptRawToken);
    db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepHash);
  } else {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  }
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.toLowerCase().includes('https')) {
    return true;
  }
  if (req.headers['x-forwarded-ssl'] === 'on') {
    return true;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.startsWith('https://')) {
    return true;
  }
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer.startsWith('https://')) {
    return true;
  }
  const host = (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host || '';
  if (host.split(',')[0].trim().endsWith('.run.app')) {
    return true;
  }
  return false;
}

export function isAiStudioIframeHost(req: Request): boolean {
  if (process.env.ALLOW_IFRAME_AUTH === 'true') return true;
  const host = ((req.headers['x-forwarded-host'] as string | undefined) || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return /^ais-(dev|pre)-[a-z0-9.-]+\.run\.app$/i.test(host);
}

export function setSessionCookie(req: Request, res: Response, rawToken: string): void {
  const maxAgeSec = Math.floor(SESSION_DURATION_MS / 1000);
  const https = isHttpsRequest(req);
  const iframeMode = https && isAiStudioIframeHost(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    ...(iframeMode
      ? ['SameSite=None', 'Secure', 'Partitioned']
      : https
      ? ['SameSite=Lax', 'Secure']
      : ['SameSite=Lax']),
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const https = isHttpsRequest(req);
  const iframeMode = https && isAiStudioIframeHost(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'Max-Age=0',
    ...(iframeMode
      ? ['SameSite=None', 'Secure', 'Partitioned']
      : https
      ? ['SameSite=Lax', 'Secure']
      : ['SameSite=Lax']),
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function extractSessionTokenFromRequest(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (cookieToken && cookieToken.length >= 16) {
    return cookieToken;
  }
  return null;
}

export function getAuthenticatedUserFromRequest(req: Request): { user: PublicAuthUser; rawToken: string } | null {
  const rawToken = extractSessionTokenFromRequest(req);
  if (!rawToken) return null;

  const db = getDb();
  const tokenHash = hashSessionToken(rawToken);
  const nowIso = new Date().toISOString();

  const row = db
    .prepare(
      `SELECT u.*, s.expires_at AS session_expires_at, s.id AS session_id
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash) as (UserRow & { session_expires_at: string; session_id: number }) | undefined;

  if (!row) return null;

  if (row.session_expires_at <= nowIso || row.is_active !== 1) {
    db.prepare('DELETE FROM user_sessions WHERE id = ?').run(row.session_id);
    return null;
  }

  // Update last_seen_at throttled (at most once per minute)
  db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?').run(nowIso, row.session_id);

  return {
    user: toPublicAuthUser(row),
    rawToken,
  };
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function pruneAttempts(record: AttemptRecord, nowMs: number): number[] {
  record.failures = record.failures.filter((t) => nowMs - t < LOGIN_WINDOW_MS);
  return record.failures;
}

export function checkLoginRateLimit(ip: string, username: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const nowMs = Date.now();
  const userIpKey = `${ip}::${username}`;

  const ipRec = attemptsByIp.get(ip);
  if (ipRec) {
    const recent = pruneAttempts(ipRec, nowMs);
    if (recent.length >= MAX_FAILS_PER_IP) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + LOGIN_WINDOW_MS - nowMs) / 1000));
      return { allowed: false, retryAfterSec };
    }
  }

  const userRec = attemptsByUserIp.get(userIpKey);
  if (userRec) {
    const recent = pruneAttempts(userRec, nowMs);
    if (recent.length >= MAX_FAILS_PER_USER_IP) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + LOGIN_WINDOW_MS - nowMs) / 1000));
      return { allowed: false, retryAfterSec };
    }
  }

  return { allowed: true };
}

const MAX_TRACKED_KEYS = 5000;

function pruneMapIfLarge(map: Map<string, AttemptRecord>, nowMs: number): void {
  if (map.size < MAX_TRACKED_KEYS) return;
  for (const [k, rec] of map.entries()) {
    pruneAttempts(rec, nowMs);
    if (rec.failures.length === 0) {
      map.delete(k);
    }
  }
  if (map.size >= MAX_TRACKED_KEYS) {
    map.clear();
  }
}

export function recordFailedLogin(ip: string, username: string): void {
  const nowMs = Date.now();
  const userIpKey = `${ip}::${username}`;

  pruneMapIfLarge(attemptsByIp, nowMs);
  pruneMapIfLarge(attemptsByUserIp, nowMs);

  const ipRec = attemptsByIp.get(ip) ?? { failures: [] };
  pruneAttempts(ipRec, nowMs);
  ipRec.failures.push(nowMs);
  attemptsByIp.set(ip, ipRec);

  const userRec = attemptsByUserIp.get(userIpKey) ?? { failures: [] };
  pruneAttempts(userRec, nowMs);
  userRec.failures.push(nowMs);
  attemptsByUserIp.set(userIpKey, userRec);
}

export function clearLoginFailures(ip: string, username: string): void {
  attemptsByUserIp.delete(`${ip}::${username}`);
}

// Express middleware helpers
export interface AuthenticatedRequest extends Request {
  authUser?: PublicAuthUser;
  authSessionToken?: string;
}

export function verifySameOriginForMutations(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const hostHeader = (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host;

  if (origin && hostHeader) {
    try {
      const parsed = new URL(origin);
      if (parsed.host !== hostHeader.split(',')[0].trim()) {
        res.status(403).json({ error: 'Cross-origin mutation rejected.' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid Origin header.' });
      return;
    }
  } else if (referer && hostHeader) {
    try {
      const parsed = new URL(referer);
      if (parsed.host !== hostHeader.split(',')[0].trim()) {
        res.status(403).json({ error: 'Cross-origin request rejected.' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid Referer header.' });
      return;
    }
  }

  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const auth = getAuthenticatedUserFromRequest(req);
  if (!auth) {
    clearSessionCookie(req, res);
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }
  req.authUser = auth.user;
  req.authSessionToken = auth.rawToken;
  next();
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (req.authUser.role !== 'admin') {
    res.status(403).json({ error: 'Administrator privileges required.' });
    return;
  }
  next();
}

export function requirePermission(...anyOfOrAll: PermissionKey[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const ok = anyOfOrAll.every((perm) => userHasPermission(req.authUser!, perm));
    if (!ok) {
      res.status(403).json({ error: 'You do not have permission to perform this action.' });
      return;
    }
    next();
  };
}

export function requireAnyPermission(...anyOf: PermissionKey[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const ok = anyOf.some((perm) => userHasPermission(req.authUser!, perm));
    if (!ok) {
      res.status(403).json({ error: 'You do not have permission to access this resource.' });
      return;
    }
    next();
  };
}

export function ensureInitialAdminUser(): void {
  const db = getDb();
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (countRow.cnt > 0) return;

  const now = new Date().toISOString();
  const passwordHash = hashPassword('admin');
  db.prepare(
    `INSERT INTO users (
      username, display_name, password_hash, role, is_active, must_change_password,
      permissions_json, created_at, updated_at, last_login_at
    ) VALUES (?, ?, ?, 'admin', 1, 1, ?, ?, ?, NULL)`
  ).run('admin', 'Administrator', passwordHash, JSON.stringify(ALL_PERMISSIONS), now, now);
}

