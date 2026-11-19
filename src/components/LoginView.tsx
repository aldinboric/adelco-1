import { AlertCircle, Eye, EyeOff, LogIn } from 'lucide-react';
import { useState } from 'react';
import type { AuthUser } from '../types';

interface LoginViewProps {
  onLoginSuccess: (user: AuthUser) => void;
  sessionNotice?: string | null;
}

export function LoginView({ onLoginSuccess, sessionNotice }: LoginViewProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedUser = username.trim();
    if (!trimmedUser || !password) {
      setError('Please enter your username and password.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: trimmedUser, password }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        user?: AuthUser;
        error?: string;
      };
      if (!res.ok || !data.user) {
        throw new Error(data.error || 'Unable to sign in.');
      }
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f7f7f7] flex flex-col justify-center px-4 py-12">
      <div className="mx-auto w-full max-w-md">
        {/* Brand Header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <img
            src="/assets/aistudio/Company_logo_1.0__Clean__no_black_shadow__bfc97f74.svg"
            alt="AdelCo Inc."
            className="h-14 w-14 object-contain"
          />
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-[#084091]">AdelCo Inc.</h1>
          <p className="mt-1 text-xs font-medium text-slate-500">
            Home Services
          </p>
        </div>

        {/* Sign-In Card */}
        <div className="rounded-lg border border-slate-200 bg-white p-7 shadow-sm">
          <div className="mb-5 border-b border-slate-100 pb-4">
            <h2 className="text-base font-bold text-slate-900">Sign in to your account</h2>
            <p className="mt-1 text-xs text-slate-500">
              Enter the credentials provided by your AdelCo Inc. administrator.
            </p>
          </div>

          {sessionNotice && !error && (
            <div className="mb-4 flex items-start gap-2.5 rounded-md border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-medium text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>{sessionNotice}</span>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2.5 rounded-md border border-red-300 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-800"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="login-username"
                className="mb-1.5 block text-xs font-semibold text-slate-700"
              >
                Username
              </label>
              <input
                id="login-username"
                type="text"
                maxLength={32}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-[#084091] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#084091]/20"
                required
              />
            </div>

            <div>
              <label
                htmlFor="login-password"
                className="mb-1.5 block text-xs font-semibold text-slate-700"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  maxLength={128}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  className="h-10 w-full rounded-md border border-slate-300 bg-white pl-3 pr-10 text-sm text-slate-900 focus:border-[#084091] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#084091]/20"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-[#084091]"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#084091] px-4 py-2 text-sm font-semibold text-white hover:bg-[#063273] disabled:bg-slate-400 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#084091]"
            >
              <LogIn className="h-4 w-4" />
              {submitting ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
