// Shared formatting helpers used by BOTH the frontend (src/) and the backend (server/).

export function formatCAD(cents: number): string {
  const value = cents / 100;
  return `$${value.toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function dollarsInputToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/,/g, '.');
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

export function centsToDollarsInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function todayIsoDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "26" -> "26 Ga" (already-suffixed values pass through). */
export function formatGaugeLabel(gauge: string | null | undefined): string | null {
  if (!gauge) return null;
  const t = gauge.trim();
  if (!t) return null;
  return /^\d+(\.\d+)?$/.test(t) ? `${t} Ga` : t;
}

/** Compact `36" x 10'` dimensions label. */
export function formatMeasureDimensions(
  widthIn: number | null | undefined,
  lengthFt: number | null | undefined
): string | null {
  const fmt = (n: number) => n.toLocaleString('en-CA', { maximumFractionDigits: 2 });
  const w = widthIn && widthIn > 0 ? `${fmt(widthIn)}"` : null;
  const l = lengthFt && lengthFt > 0 ? `${fmt(lengthFt)}'` : null;
  if (w && l) return `${w} x ${l}`;
  return w || l;
}

/** Compact `36" · 26 Ga · 10'` label for a material's saved measures. */
export function formatMaterialMeasures(m: {
  width_in: number | null;
  gauge: string | null;
  length_ft: number | null;
}): string | null {
  const parts = [formatGaugeLabel(m.gauge), formatMeasureDimensions(m.width_in, m.length_ft)].filter(
    Boolean
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}
