import {
  Ban,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_USER_PERMISSIONS,
  EMPTY_USER_PERMISSIONS,
  type UserPermissions,
  type UserRole,
} from '../../shared/permissions.ts';
import type { AuthUser } from '../types';
import { apiFetch } from '../utils/api';
import { ConfirmModal } from './ConfirmModal';
import { TableSkeleton } from './TableSkeleton';

interface AdminViewProps {
  currentUser: AuthUser;
  onCurrentUserUpdated: (user: AuthUser) => void;
  onNotify: (type: 'success' | 'error', text: string) => void;
}

const PERMISSION_GROUPS: Array<{
  title: string;
  items: Array<{ key: keyof UserPermissions; label: string; description: string }>;
}> = [
  {
    title: 'Quoting',
    items: [
      {
        key: 'customer_quote',
        label: 'Customer Quote',
        description: 'Build draft quotes and issue new quotes',
      },
      {
        key: 'issued_quotes_view',
        label: 'View Issued Quotes',
        description: 'Open Issued Quotes ledger and print previews',
      },
      {
        key: 'issued_quotes_manage',
        label: 'Manage Issued Quotes',
        description: 'Copy quotes to new drafts or delete issued quotes',
      },
    ],
  },
  {
    title: 'Catalogs',
    items: [
      {
        key: 'products_view',
        label: 'View Products',
        description: 'Browse the Products catalog',
      },
      {
        key: 'products_manage',
        label: 'Manage Products',
        description: 'Add, edit, disable/enable, and delete products',
      },
      {
        key: 'colors_view',
        label: 'View Colors',
        description: 'Browse the Colors catalog',
      },
      {
        key: 'colors_manage',
        label: 'Manage Colors',
        description: 'Add, edit, disable/enable, and delete colors',
      },
      {
        key: 'catalog_reorder',
        label: 'Reorder Catalog Items',
        description: 'Drag & drop rows to change the order of Products and Colors tables',
      },
    ],
  },
  {
    title: 'Exports & System',
    items: [
      {
        key: 'exports',
        label: 'Exports & Printing',
        description: 'Export Excel/PDF reports and print quotes',
      },
      {
        key: 'backup_settings',
        label: 'Backup & Settings',
        description: 'Download/restore .zip backups and change quote prefix',
      },
    ],
  },
];

function summarizePermissions(user: AuthUser): string {
  if (user.role === 'admin') {
    return 'Full Administrator Access';
  }
  const perms = user.permissions;
  const totalKeys = Object.keys(perms).length;
  const enabledCount = Object.values(perms).filter(Boolean).length;
  if (enabledCount === totalKeys) return 'All Modules (9/9)';
  if (enabledCount === 0) return 'No Modules Enabled (0/9)';
  return `${enabledCount} / ${totalKeys} permissions enabled`;
}

export function AdminView({
  currentUser,
  onCurrentUserUpdated,
  onNotify,
}: AdminViewProps) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);

  // Admin own profile / credentials form
  const [ownUsername, setOwnUsername] = useState(currentUser.username);
  const [ownDisplayName, setOwnDisplayName] = useState(currentUser.display_name);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showOwnPasswords, setShowOwnPasswords] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Add/Edit user modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AuthUser | null>(null);
  const [formUsername, setFormUsername] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState<UserRole>('user');
  const [formActive, setFormActive] = useState(true);
  const [formPermissions, setFormPermissions] = useState<UserPermissions>({
    ...DEFAULT_USER_PERMISSIONS,
  });
  const [showFormPassword, setShowFormPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savingUser, setSavingUser] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<AuthUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setOwnUsername(currentUser.username);
    setOwnDisplayName(currentUser.display_name);
  }, [currentUser.username, currentUser.display_name]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/users');
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load users.');
      }
      setUsers(data as AuthUser[]);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleSaveOwnProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileError(null);

    if (!currentPassword) {
      setProfileError('Enter your current password to confirm account changes.');
      return;
    }
    if (newPassword && newPassword.length < 8) {
      setProfileError('New password must be at least 8 characters long.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setProfileError('New password and confirmation do not match.');
      return;
    }

    setSavingProfile(true);
    try {
      const res = await apiFetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: ownUsername.trim(),
          display_name: ownDisplayName.trim(),
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      const data = (await res.json()) as {
        user?: AuthUser;
        error?: string;
      };
      if (!res.ok || !data.user) {
        throw new Error(data.error || 'Failed to update account credentials.');
      }
      onCurrentUserUpdated(data.user);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      await loadUsers();
      onNotify('success', 'Administrator credentials updated.');
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Failed to update account.');
    } finally {
      setSavingProfile(false);
    }
  };

  const openAddModal = () => {
    setEditingUser(null);
    setFormUsername('');
    setFormDisplayName('');
    setFormPassword('');
    setFormRole('user');
    setFormActive(true);
    setFormPermissions({ ...DEFAULT_USER_PERMISSIONS });
    setShowFormPassword(false);
    setFormError(null);
    setModalOpen(true);
  };

  const openEditModal = (user: AuthUser) => {
    setEditingUser(user);
    setFormUsername(user.username);
    setFormDisplayName(user.display_name);
    setFormPassword('');
    setFormRole(user.role);
    setFormActive(user.is_active);
    setFormPermissions({ ...user.permissions });
    setShowFormPassword(false);
    setFormError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingUser(null);
    setFormError(null);
  };

  const togglePermission = (key: keyof UserPermissions) => {
    setFormPermissions((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (key === 'issued_quotes_manage' && next.issued_quotes_manage) next.issued_quotes_view = true;
      if (key === 'issued_quotes_view' && !next.issued_quotes_view) next.issued_quotes_manage = false;
      if (key === 'products_manage' && next.products_manage) next.products_view = true;
      if (key === 'products_view' && !next.products_view) next.products_manage = false;
      if (key === 'colors_manage' && next.colors_manage) next.colors_view = true;
      if (key === 'colors_view' && !next.colors_view) next.colors_manage = false;
      return next;
    });
  };

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!formUsername.trim()) {
      setFormError('Username is required.');
      return;
    }
    if (!formDisplayName.trim()) {
      setFormError('Display name is required.');
      return;
    }
    if (!editingUser && formPassword.length < 8) {
      setFormError('Initial password must be at least 8 characters long.');
      return;
    }
    if (editingUser && formPassword.length > 0 && formPassword.length < 8) {
      setFormError('New password must be at least 8 characters long.');
      return;
    }

    setSavingUser(true);
    try {
      const endpoint = editingUser ? `/api/admin/users/${editingUser.id}` : '/api/admin/users';
      const method = editingUser ? 'PUT' : 'POST';
      const res = await apiFetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: formUsername.trim(),
          display_name: formDisplayName.trim(),
          password: formPassword,
          role: formRole,
          is_active: formActive,
          permissions: formPermissions,
        }),
      });
      const data = (await res.json()) as AuthUser & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save user.');
      }
      if (data.id === currentUser.id) {
        onCurrentUserUpdated(data);
      }
      await loadUsers();
      onNotify('success', editingUser ? `Updated user ${data.username}.` : `Created user ${data.username}.`);
      closeModal();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save user.');
    } finally {
      setSavingUser(false);
    }
  };

  const handleToggleActive = async (user: AuthUser) => {
    try {
      const res = await apiFetch(`/api/admin/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: user.username,
          display_name: user.display_name,
          role: user.role,
          is_active: !user.is_active,
          permissions: user.permissions,
        }),
      });
      const data = (await res.json()) as AuthUser & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update status.');
      }
      await loadUsers();
      onNotify('success', `${data.username} is now ${data.is_active ? 'Active' : 'Disabled'}.`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to update user status.');
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/admin/users/${deleteTarget.id}`, { method: 'DELETE' });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete user.');
      }
      await loadUsers();
      onNotify('success', `User ${deleteTarget.username} permanently deleted.`);
      setDeleteTarget(null);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  };

  const activeUsersCount = users.filter((u) => u.is_active).length;

  return (
    <div className="space-y-5">
      {/* Own Administrator Account Security */}
      <div className="ui-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3.5">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#eef4fc] text-[#084091]">
              <KeyRound className="h-3.5 w-3.5" />
            </div>
            <h2 className="text-sm font-bold text-slate-900">My Administrator Credentials</h2>
          </div>
          <span className="text-xs text-slate-500">
            Update your own login username, display name, or password
          </span>
        </div>

        <form onSubmit={handleSaveOwnProfile} className="mt-4 space-y-4">
          {profileError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
              {profileError}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <label className="ui-label">Admin Username</label>
              <input
                type="text"
                maxLength={32}
                value={ownUsername}
                onChange={(e) => setOwnUsername(e.target.value)}
                className="ui-input font-mono text-xs"
                required
              />
            </div>

            <div>
              <label className="ui-label">Display Name</label>
              <input
                type="text"
                maxLength={80}
                value={ownDisplayName}
                onChange={(e) => setOwnDisplayName(e.target.value)}
                className="ui-input text-xs"
                required
              />
            </div>

            <div>
              <label className="ui-label">Current Password</label>
              <input
                type={showOwnPasswords ? 'text' : 'password'}
                maxLength={128}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Required to save"
                autoComplete="current-password"
                className="ui-input text-xs"
                required
              />
            </div>

            <div>
              <label className="ui-label">
                New Password <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                type={showOwnPasswords ? 'text' : 'password'}
                maxLength={128}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min 8 characters"
                autoComplete="new-password"
                className="ui-input text-xs"
              />
            </div>

            <div>
              <label className="ui-label">Confirm New Password</label>
              <input
                type={showOwnPasswords ? 'text' : 'password'}
                maxLength={128}
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                placeholder="Repeat new password"
                autoComplete="new-password"
                className="ui-input text-xs"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={() => setShowOwnPasswords((v) => !v)}
              className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              {showOwnPasswords ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {showOwnPasswords ? 'Hide passwords' : 'Show passwords'}
            </button>

            <button type="submit" disabled={savingProfile} className="ui-btn-primary">
              <ShieldCheck className="h-3.5 w-3.5" />
              {savingProfile ? 'Updating...' : 'Update My Credentials'}
            </button>
          </div>
        </form>
      </div>

      {/* Users & Permissions Toolbar */}
      <div className="ui-card flex flex-wrap items-center justify-between gap-4 px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-500">
          <span className="font-semibold text-slate-800">{users.length} total accounts</span>
          <span className="text-slate-300" aria-hidden="true">·</span>
          <span>{activeUsersCount} active</span>
          <span className="text-slate-300" aria-hidden="true">·</span>
          <span>Accounts can only be provisioned by an administrator</span>
        </div>

        <button type="button" onClick={openAddModal} className="ui-btn-green">
          <Plus className="h-3.5 w-3.5" />
          Add User
        </button>
      </div>

      {/* Users Table */}
      <div className="ui-card overflow-hidden">
        {loading ? (
          <TableSkeleton rows={3} rowHeightClass="h-11" cells={['h-4 w-8', 'h-4 w-44', 'h-4 w-24']} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-left text-sm">
              <thead>
                <tr className="ui-table-head">
                  <th className="px-4 py-3 w-14 text-left">#</th>
                  <th className="px-4 py-3 text-left">User</th>
                  <th className="px-4 py-3 w-28 text-left">Role</th>
                  <th className="px-4 py-3 text-left">Permissions</th>
                  <th className="px-4 py-3 w-28 text-left">Status</th>
                  <th className="px-4 py-3 w-40 text-right">Last Sign-In</th>
                  <th className="px-4 py-3 w-56 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u, idx) => {
                  const isSelf = u.id === currentUser.id;
                  return (
                    <tr
                      key={u.id}
                      className={`transition-colors ${
                        !u.is_active ? 'bg-slate-50/80 text-slate-400' : 'bg-white hover:bg-slate-50/70'
                      }`}
                    >
                      <td className="px-4 py-3 text-left font-mono text-xs tabular-nums text-slate-400">
                        {idx + 1}
                      </td>
                      <td className="px-4 py-3 text-left">
                        <div className="font-medium text-slate-900">
                          {u.display_name}
                          {isSelf && (
                            <span className="ml-2 rounded-full bg-[#eef4fc] px-2 py-0.5 text-[10px] font-semibold text-[#084091]">
                              You
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-xs text-slate-500">@{u.username}</div>
                      </td>
                      <td className="px-4 py-3 text-left text-xs font-semibold">
                        {u.role === 'admin' ? (
                          <span className="inline-flex items-center rounded-full bg-[#eef4fc] px-2.5 py-0.5 text-[11px] font-semibold text-[#084091]">
                            Admin
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700">
                            User
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-left text-xs text-slate-600">
                        {summarizePermissions(u)}
                      </td>
                      <td className="px-4 py-3 text-left">
                        {u.is_active ? (
                          <span className="ui-badge-available">Active</span>
                        ) : (
                          <span className="ui-badge-unavailable">Disabled</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-slate-500">
                        {u.last_login_at ? u.last_login_at.slice(0, 16).replace('T', ' ') : 'Never'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => openEditModal(u)}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap transition-colors"
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleActive(u)}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap transition-colors"
                          >
                            {u.is_active ? (
                              <>
                                <Ban className="h-3 w-3 text-amber-600" />
                                Disable
                              </>
                            ) : (
                              <>
                                <CheckCircle2 className="h-3 w-3 text-[#2a6f3b]" />
                                Enable
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            disabled={isSelf}
                            onClick={() => setDeleteTarget(u)}
                            className="inline-flex cursor-pointer items-center rounded-lg border border-red-200/80 bg-white p-1.5 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                            title={isSelf ? 'Cannot delete your own active account' : 'Delete user'}
                            aria-label={`Delete ${u.username}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit User Modal */}
      {modalOpen && (
        <div className="ui-modal-backdrop" role="dialog" aria-modal="true">
          <div className="flex min-h-full items-center justify-center p-4">
            <div className="ui-modal-panel max-w-2xl my-6">
              <div className="ui-modal-header">
                <h3 className="text-base font-semibold text-slate-900">
                  {editingUser ? `Edit User @${editingUser.username}` : 'Create User Account'}
                </h3>
                <button type="button" onClick={closeModal} className="ui-icon-btn" aria-label="Close">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <form onSubmit={handleSaveUser} className="space-y-4 px-6 py-5">
                {formError && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
                    {formError}
                  </div>
                )}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="ui-label">Username</label>
                    <input
                      type="text"
                      maxLength={32}
                      value={formUsername}
                      onChange={(e) => setFormUsername(e.target.value)}
                      placeholder="e.g. john.smith"
                      className="ui-input font-mono text-xs"
                      required
                    />
                    <p className="mt-1 text-[11px] text-slate-500">
                      3–32 characters (lowercase letters, numbers, ., _, -)
                    </p>
                  </div>

                  <div>
                    <label className="ui-label">Display Name</label>
                    <input
                      type="text"
                      maxLength={80}
                      value={formDisplayName}
                      onChange={(e) => setFormDisplayName(e.target.value)}
                      placeholder="e.g. John Smith"
                      className="ui-input text-xs"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="sm:col-span-1">
                    <label className="ui-label">Role</label>
                    <select
                      value={formRole}
                      onChange={(e) => setFormRole(e.target.value === 'admin' ? 'admin' : 'user')}
                      className="ui-input text-xs font-medium"
                    >
                      <option value="user">Standard User</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </div>

                  <div className="sm:col-span-2">
                    <label className="ui-label">
                      {editingUser ? 'Reset Password (leave blank to keep current)' : 'Initial Password'}
                    </label>
                    <div className="relative">
                      <input
                        type={showFormPassword ? 'text' : 'password'}
                        maxLength={128}
                        value={formPassword}
                        onChange={(e) => setFormPassword(e.target.value)}
                        placeholder={editingUser ? 'Optional (min 8 chars)' : 'Minimum 8 characters'}
                        autoComplete="new-password"
                        className="ui-input pr-10 text-xs"
                        required={!editingUser}
                      />
                      <button
                        type="button"
                        onClick={() => setShowFormPassword((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-slate-400 hover:text-slate-600"
                        aria-label={showFormPassword ? 'Hide password' : 'Show password'}
                      >
                        {showFormPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 pt-1">
                  <input
                    id="user-active-checkbox"
                    type="checkbox"
                    checked={formActive}
                    onChange={(e) => setFormActive(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-[#084091] focus:ring-[#084091]"
                  />
                  <label htmlFor="user-active-checkbox" className="text-xs font-medium text-slate-800">
                    Account is active and permitted to sign in
                  </label>
                </div>

                {/* Permissions Matrix */}
                <div className="border-t border-slate-100 pt-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-xs font-bold text-slate-900">
                        Module & Action Permissions
                      </h4>
                      <p className="text-[11px] text-slate-500">
                        {formRole === 'admin'
                          ? 'Administrators automatically have full access to all modules and user management.'
                          : 'All modules are enabled by default. Uncheck any area or action you want to restrict.'}
                      </p>
                    </div>

                    {formRole === 'user' && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setFormPermissions({ ...DEFAULT_USER_PERMISSIONS })}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Enable All
                        </button>
                        <button
                          type="button"
                          onClick={() => setFormPermissions({ ...EMPTY_USER_PERMISSIONS })}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Clear All
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {PERMISSION_GROUPS.map((group) => (
                      <div
                        key={group.title}
                        className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 space-y-2.5"
                      >
                        <div className="text-[11px] font-bold uppercase tracking-wide text-[#084091]">
                          {group.title}
                        </div>
                        {group.items.map((item) => {
                          const checked =
                            formRole === 'admin' ? true : Boolean(formPermissions[item.key]);
                          return (
                            <label
                              key={item.key}
                              className={`flex items-start gap-2 text-xs ${
                                formRole === 'admin' ? 'opacity-65 cursor-not-allowed' : 'cursor-pointer'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={formRole === 'admin'}
                                onChange={() => togglePermission(item.key)}
                                className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-[#084091] focus:ring-[#084091]"
                              />
                              <div>
                                <div className="font-medium text-slate-800">{item.label}</div>
                                <div className="text-[11px] leading-tight text-slate-500">
                                  {item.description}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2.5 border-t border-slate-100 pt-4">
                  <button
                    type="button"
                    onClick={closeModal}
                    disabled={savingUser}
                    className="ui-btn-secondary"
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={savingUser} className="ui-btn-primary">
                    {savingUser ? 'Saving...' : editingUser ? 'Save Changes' : 'Create User'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={deleteTarget !== null}
        title="Delete User Account?"
        message={`Are you sure you want to permanently delete "@${deleteTarget?.username ?? ''}"? All active sessions for this user will be immediately terminated.`}
        confirmLabel="Delete User"
        tone="danger"
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
