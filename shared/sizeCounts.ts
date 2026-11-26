// The one place that answers how a Product's Sizes read as counts per Material Type —
// shared by the Products table (src/) and the products spreadsheet export (server/).

/** A Material Type as far as the Sizes column cares: its name, and its Sizes. */
export interface MaterialTypeWithSizes {
  name: string;
  sizes: readonly unknown[];
}

/** What a Product with no Material Types — a Preview — reads in the same column. */
const NO_MATERIAL_TYPES = 'No material types';

/** `no sizes`, `1 size`, `5 sizes`. */
export function sizeCountLabel(count: number): string {
  if (count === 0) return 'no sizes';
  return count === 1 ? '1 size' : `${count} sizes`;
}

/**
 * One line per Material Type saying how many Sizes it has — `Aluminum · 5 sizes` —
 * so the cell answers "is this Product fully configured?" and nothing else.
 */
export function sizesColumnLines(materialTypes: readonly MaterialTypeWithSizes[]): string[] {
  if (materialTypes.length === 0) return [NO_MATERIAL_TYPES];
  return materialTypes.map((m) => `${m.name} · ${sizeCountLabel(m.sizes.length)}`);
}
