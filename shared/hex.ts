// Shared HEX color helpers used by BOTH the frontend (src/) and the backend (server/).

const HEX6_REGEX = /^[0-9A-F]{6}$/;
const HEX_REGEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * Strict validation: accepts "RRGGBB" or "#RRGGBB" and returns normalized "#RRGGBB",
 * or null when invalid. Used for user input validation.
 */
export function normalizeHexStrict(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  if (!HEX_REGEX.test(withHash)) return null;
  return withHash.toUpperCase();
}

/**
 * Display helper: normalizes a stored hex value, falling back when malformed.
 * Used when rendering swatches / PDF colors.
 */
export function normalizeHexDisplay(hex: string, fallback = '#D4D4D8'): string {
  const clean = hex.replace('#', '').trim().toUpperCase();
  return HEX6_REGEX.test(clean) ? `#${clean}` : fallback;
}

/** Converts "#RRGGBB" to Excel ARGB "FFRRGGBB" (opaque). */
export function hexToArgb(hex: string): string {
  const clean = hex.replace('#', '').trim().toUpperCase();
  if (HEX6_REGEX.test(clean)) {
    return `FF${clean}`;
  }
  return 'FFD4D4D8';
}
