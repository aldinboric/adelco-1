import { type Request, type Response, Router } from 'express';
import {
  ALL_PERMISSIONS,
  type AuthenticatedRequest,
  checkLoginRateLimit,
  clearLoginFailures,
  clearSessionCookie,
  createUserSession,
  extractSessionTokenFromRequest,
  getClientIp,
  hashPassword,
  hashPasswordAsync,
  normalizeUsername,
  recordFailedLogin,
  requireAdmin,
  requireAuth,
  revokeSessionByRawToken,
  revokeUserSessions,
  sanitizePermissions,
  setSessionCookie,
  toPublicAuthUser,
  validatePasswordStrength,
  verifyPasswordAsync,
} from '../auth.ts';
import { getDb, type UserRow } from '../db.ts';
import { parsePositiveInt } from '../validation.ts';

export function createAuthRouter(): Router {
  const router = Router();
  const DUMMY_PASSWORD_HASH = hashPassword('adelco-dummy-timing-guard-2026');

  router.post('/auth/login', async (req: Request, res: Response) => {
    const rawUsername =
      typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const rawPassword = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!rawUsername || !rawPassword) {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }

    const clientIp = getClientIp(req);
    const rateCheck = checkLoginRateLimit(clientIp, rawUsername);
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfterSec));
      res.status(429).json({
        error: `Too many failed sign-in attempts. Please wait ${Math.ceil(rateCheck.retryAfterSec / 60)} minute(s) and try again.`,
      });
      return;
    }

    const db = getDb();
    const userRow = db.prepare('SELECT * FROM users WHERE username = ?').get(rawUsername) as
      | UserRow
      | undefined;

    if (!userRow) {
      // Burn the same scrypt work so timing does not reveal whether the user exists.
      await verifyPasswordAsync(rawPassword, DUMMY_PASSWORD_HASH);
      recordFailedLogin(clientIp, rawUsername);
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    if (!(await verifyPasswordAsync(rawPassword, userRow.password_hash))) {
      recordFailedLogin(clientIp, rawUsername);
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    if (userRow.is_active !== 1) {
      recordFailedLogin(clientIp, rawUsername);
      res.status(403).json({ error: 'This account has been disabled by an administrator.' });
      return;
    }

    clearLoginFailures(clientIp, rawUsername);
    const now = new Date().toISOString();
    db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, userRow.id);

    const { rawToken } = createUserSession(userRow.id);
    setSessionCookie(req, res, rawToken);

    const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userRow.id) as UserRow;
    res.json({ user: toPublicAuthUser(freshUser) });
  });

  router.post('/auth/logout', (req: Request, res: Response) => {
    const raw = extractSessionTokenFromRequest(req);
    if (raw) {
      revokeSessionByRawToken(raw);
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    res.json({ user: req.authUser });
  });

  router.put('/auth/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const currentUser = req.authUser!;
    const currentPassword = typeof req.body?.current_password === 'string' ? req.body.current_password : '';
    const displayNameRaw = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';
    const newUsernameRaw = req.body?.username;
    const newPasswordRaw = typeof req.body?.new_password === 'string' ? req.body.new_password : '';

    if (!currentPassword) {
      res.status(400).json({ error: 'Current password is required to verify changes.' });
      return;
    }

    const clientIp = getClientIp(req);
    const rateKey = `profile:${currentUser.username}`;
    const rateCheck = checkLoginRateLimit(clientIp, rateKey);
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfterSec));
      res.status(429).json({ error: 'Too many incorrect password attempts. Please wait and try again.' });
      return;
    }

    const db = getDb();
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(currentUser.id) as UserRow | undefined;
    if (!userRow || !(await verifyPasswordAsync(currentPassword, userRow.password_hash))) {
      recordFailedLogin(clientIp, rateKey);
      res.status(401).json({ error: 'Current password is incorrect.' });
      return;
    }
    clearLoginFailures(clientIp, rateKey);

    let nextUsername = userRow.username;
    if (currentUser.role === 'admin' && typeof newUsernameRaw === 'string' && newUsernameRaw.trim() !== '') {
      const normalized = normalizeUsername(newUsernameRaw);
      if (!normalized) {
        res.status(400).json({
          error: 'Username must be 3–32 characters using lowercase letters, numbers, dots, underscores, or hyphens.',
        });
        return;
      }
      if (normalized !== userRow.username) {
        const collision = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(normalized, userRow.id);
        if (collision) {
          res.status(409).json({ error: 'That username is already in use.' });
          return;
        }
        nextUsername = normalized;
      }
    }

    const nextDisplayName = displayNameRaw ? displayNameRaw.slice(0, 80) : userRow.display_name;
    let nextPasswordHash = userRow.password_hash;
    let nextMustChange = userRow.must_change_password;
    let passwordChanged = false;

    if (newPasswordRaw.length > 0) {
      const check = validatePasswordStrength(newPasswordRaw);
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
      nextPasswordHash = await hashPasswordAsync(check.password);
      nextMustChange = 0;
      passwordChanged = true;
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE users
       SET username = ?, display_name = ?, password_hash = ?, must_change_password = ?, updated_at = ?
       WHERE id = ?`
    ).run(nextUsername, nextDisplayName, nextPasswordHash, nextMustChange, now, userRow.id);

    if (passwordChanged || nextUsername !== userRow.username) {
      revokeUserSessions(userRow.id);
      const { rawToken } = createUserSession(userRow.id);
      setSessionCookie(req, res, rawToken);
    }

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userRow.id) as UserRow;
    res.json({ user: toPublicAuthUser(updated) });
  });

  // ============================================================================
  // ADMIN USER & PERMISSION MANAGEMENT
  // ============================================================================
  router.get('/admin/users', requireAuth, requireAdmin, (_req: AuthenticatedRequest, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM users ORDER BY id ASC').all() as UserRow[];
    res.json(rows.map(toPublicAuthUser));
  });

  router.post('/admin/users', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const username = normalizeUsername(req.body?.username);
    if (!username) {
      res.status(400).json({
        error: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.',
      });
      return;
    }

    const displayName =
      typeof req.body?.display_name === 'string' ? req.body.display_name.trim().slice(0, 80) : '';
    if (!displayName) {
      res.status(400).json({ error: 'Display name is required.' });
      return;
    }

    const passCheck = validatePasswordStrength(req.body?.password);
    if (!passCheck.ok) {
      res.status(400).json({ error: passCheck.error });
      return;
    }

    const role = req.body?.role === 'admin' ? 'admin' : 'user';
    const isActive = req.body?.is_active === false ? 0 : 1;
    const permissions =
      role === 'admin' ? ALL_PERMISSIONS : sanitizePermissions(req.body?.permissions);

    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      res.status(409).json({ error: `Username "${username}" already exists.` });
      return;
    }

    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO users (
          username, display_name, password_hash, role, is_active, must_change_password,
          permissions_json, created_at, updated_at, last_login_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, NULL)`
      )
      .run(
        username,
        displayName,
        await hashPasswordAsync(passCheck.password),
        role,
        isActive,
        JSON.stringify(permissions),
        now,
        now
      );

    const created = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as UserRow;
    res.status(201).json(toPublicAuthUser(created));
  });

  router.put('/admin/users/:id', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid user ID.' });
      return;
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const username = normalizeUsername(req.body?.username ?? existing.username);
    if (!username) {
      res.status(400).json({
        error: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.',
      });
      return;
    }

    if (username !== existing.username) {
      const collision = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, id);
      if (collision) {
        res.status(409).json({ error: `Username "${username}" already exists.` });
        return;
      }
    }

    const displayName =
      typeof req.body?.display_name === 'string'
        ? req.body.display_name.trim().slice(0, 80)
        : existing.display_name;
    if (!displayName) {
      res.status(400).json({ error: 'Display name is required.' });
      return;
    }

    const role = req.body?.role === 'admin' ? 'admin' : 'user';
    const isActive =
      typeof req.body?.is_active === 'boolean' ? (req.body.is_active ? 1 : 0) : existing.is_active;

    if (existing.role === 'admin' && (role !== 'admin' || isActive !== 1)) {
      const otherActiveAdminCount = (
        db
          .prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?")
          .get(id) as { cnt: number }
      ).cnt;
      if (otherActiveAdminCount === 0) {
        res.status(400).json({ error: 'Cannot disable or demote the last active administrator.' });
        return;
      }
    }

    let nextPasswordHash = existing.password_hash;
    let nextMustChange = existing.must_change_password;
    let passwordReset = false;

    if (typeof req.body?.password === 'string' && req.body.password.length > 0) {
      const passCheck = validatePasswordStrength(req.body.password);
      if (!passCheck.ok) {
        res.status(400).json({ error: passCheck.error });
        return;
      }
      nextPasswordHash = await hashPasswordAsync(passCheck.password);
      nextMustChange = 0;
      passwordReset = true;
    }

    const permissions =
      role === 'admin' ? ALL_PERMISSIONS : sanitizePermissions(req.body?.permissions);

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE users
       SET username = ?, display_name = ?, password_hash = ?, role = ?, is_active = ?, must_change_password = ?, permissions_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      username,
      displayName,
      nextPasswordHash,
      role,
      isActive,
      nextMustChange,
      JSON.stringify(permissions),
      now,
      id
    );

    if (isActive === 0 || passwordReset || role !== existing.role) {
      revokeUserSessions(id, id === req.authUser?.id ? req.authSessionToken : undefined);
    }

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
    res.json(toPublicAuthUser(updated));
  });

  router.delete('/admin/users/:id', requireAuth, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid user ID.' });
      return;
    }
    if (req.authUser && req.authUser.id === id) {
      res.status(400).json({ error: 'You cannot delete your own active account.' });
      return;
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    if (existing.role === 'admin' && existing.is_active === 1) {
      const otherAdmins = (
        db
          .prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?")
          .get(id) as { cnt: number }
      ).cnt;
      if (otherAdmins === 0) {
        res.status(400).json({ error: 'Cannot delete the last active administrator.' });
        return;
      }
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ deleted: true });
  });

  return router;
}
