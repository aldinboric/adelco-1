import { AlertTriangle, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { AuthUser } from '../types';
import { apiFetch } from '../utils/api';

interface ForcePasswordChangeViewProps {
  currentUser: AuthUser;
  onDone: (user: AuthUser) => void;
}

/**
 * Shown when the signed-in account still has must_change_password set (e.g. the seeded
 * default admin account). The backend blocks every other API route until the password
 * is changed, so this is the only screen available.
 */
export function ForcePasswordChangeView({ currentUser, onDone }: ForcePasswordChangeViewProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!currentPassword) {
      setError('Enter your current password to confirm the change.');
      return;
    }
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      const data = (await res.json()) as { user?: AuthUser; error?: string };
      if (!res.ok || !data.user) {
        throw new Error(data.error || 'Failed to update password.');
      }
      onDone(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f7f7f7] flex flex-col justify-center px-4 py-12">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <img
            src="/assets/logo/Company_logo_1.0__Clean__no_black_shadow__bfc97f74.svg"
            alt="AdelCo Inc."
            className="h-14 w-14 object-contain"
          />
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-[#084091]">AdelCo Inc.</h1>
        </div>

        <div className="rounded-lg border border-amber-300 bg-white p-7 shadow-sm">
          <div className="mb-5 flex items-start gap-2.5 rounded-md border border-amber-300 bg-amber-50 px-3.5 py-3 text-xs font-medium text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>
              <strong>Security requirement:</strong> Your account <span className="font-mono font-semibold">@{currentUser.username}</span> is
              still using the default password. For security, all other actions are locked until
              you set a new password below.
            </span>
          </div>

          <div className="mb-5 border-b border-slate-100 pb-4">
            <h2 className="text-base font-bold text-slate-900">Set a new password</h2>
            <p className="mt-1 text-xs text-slate-500">
              Confirm your current password, then choose a strong new one (min. 8 characters, not a
              common password).
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2.5 rounded-md border border-red-300 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-800"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                Current Password
              </label>
              <input
                type={showPasswords ? 'text' : 'password'}
                maxLength={128}
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-[#084091] focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                New Password
              </label>
              <input
                type={showPasswords ? 'text' : 'password'}
                maxLength={128}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min 8 characters"
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-[#084091] focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                Confirm New Password
              </label>
              <input
                type={showPasswords ? 'text' : 'password'}
                maxLength={128}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat new password"
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-[#084091] focus:outline-none"
                required
              />
            </div>

            <button
              type="button"
              onClick={() => setShowPasswords((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              {showPasswords ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {showPasswords ? 'Hide passwords' : 'Show passwords'}
            </button>

            <button
              type="submit"
              disabled={submitting}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#084091] px-4 py-2 text-sm font-semibold text-white hover:bg-[#063273] disabled:bg-slate-400 transition-colors"
            >
              {submitting ? (
                'Saving...'
              ) : (
                <>
                  <ShieldCheck className="h-4 w-4" />
                  Set New Password & Continue
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
