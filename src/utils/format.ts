// Formatting helpers are shared with the backend — re-exported here for convenience.
export {
  centsToDollarsInput,
  dollarsInputToCents,
  formatCAD,
  formatGaugeLabel,
  formatMaterialMeasures,
  formatMeasureDimensions,
  todayIsoDate,
} from '../../shared/format.ts';
export { normalizeHexStrict as normalizeHexPreview } from '../../shared/hex.ts';

export function getImageUrl(relPath: string | null | undefined): string | null {
  if (!relPath) return null;
  const cleaned = relPath.replace(/^\/+/, '');
  return `/api/images/${cleaned}`;
}

export function downloadBlobResponse(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
