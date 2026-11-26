import type { ProductMaterial } from '../types';

/** A Material Type as far as the Products table's Sizes column cares: its name, and its Sizes. */
export type MaterialTypeWithSizes = Pick<ProductMaterial, 'name' | 'sizes'>;

/** What a Product with no Material Types — a Preview — reads in the same column. */
const NO_MATERIAL_TYPES = 'No material types';

/** `no sizes`, `1 size`, `5 sizes`. */
export function sizeCountLabel(count: number): string {
  if (count === 0) return 'no sizes';
  return count === 1 ? '1 size' : `${count} sizes`;
}

/**
 * The Products table's Sizes column: one line per Material Type saying how many Sizes it has,
 * so the cell answers "is this Product fully configured?" and nothing else. Prices stay out.
 */
export function sizesColumnLines(materialTypes: readonly MaterialTypeWithSizes[]): string[] {
  if (materialTypes.length === 0) return [NO_MATERIAL_TYPES];
  return materialTypes.map((m) => `${m.name} · ${sizeCountLabel(m.sizes.length)}`);
}
