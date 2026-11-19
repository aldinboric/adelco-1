import { downloadBlobResponse } from './format';

let unauthorizedCallback: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedCallback = fn;
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, {
    ...init,
    credentials: 'same-origin',
  });

  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const isLoginOrMe = urlStr.includes('/api/auth/login') || urlStr.includes('/api/auth/me');

  if (res.status === 401 && !isLoginOrMe && unauthorizedCallback) {
    unauthorizedCallback();
  }

  return res;
}

export async function downloadProtectedFile(url: string, fallbackFilename: string): Promise<void> {
  const res = await apiFetch(url);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || 'Download failed.');
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^"]+)"?/i.exec(disposition);
  const filename = match?.[1] ?? fallbackFilename;
  const blob = await res.blob();
  downloadBlobResponse(blob, filename);
}
