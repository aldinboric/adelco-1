import { describe, expect, it } from 'vitest';
import type { ProductMaterialSize } from '../types';
import { sizesColumnLines, type MaterialTypeWithSizes } from './sizeCounts.ts';

function materialType(name: string, sizeCount: number): MaterialTypeWithSizes {
  const sizes: ProductMaterialSize[] = Array.from({ length: sizeCount }, (_, i) => ({
    id: i + 1,
    material_id: 1,
    price_per_lf_cents: 1500,
    width_in: null,
    gauge: null,
    length_ft: null,
    sort_order: i,
    created_at: '2026-01-01T00:00:00.000Z',
  }));
  return { name, sizes };
}

describe('Products table Sizes column', () => {
  it('reports how many Sizes a Material Type has', () => {
    expect(sizesColumnLines([materialType('Aluminum', 5)])).toEqual(['Aluminum · 5 sizes']);
  });

  it('says "no sizes" for a Material Type without any', () => {
    expect(sizesColumnLines([materialType('Wood', 0)])).toEqual(['Wood · no sizes']);
  });

  it('keeps the Material Types in their own order', () => {
    expect(
      sizesColumnLines([
        materialType('Wood', 2),
        materialType('Aluminum', 0),
        materialType('Metal', 4),
      ])
    ).toEqual(['Wood · 2 sizes', 'Aluminum · no sizes', 'Metal · 4 sizes']);
  });

  it('uses the singular for a Material Type with one Size', () => {
    expect(sizesColumnLines([materialType('Metal', 1)])).toEqual(['Metal · 1 size']);
  });

  it('says "No material types" for a Product that has none', () => {
    expect(sizesColumnLines([])).toEqual(['No material types']);
  });

  it('gives every Material Type its own line, however many there are', () => {
    const names = ['Aluminum', 'Metal', 'Wood', 'Steel', 'Copper', 'Zinc'];
    expect(sizesColumnLines(names.map((name) => materialType(name, 2)))).toEqual(
      names.map((name) => `${name} · 2 sizes`)
    );
  });
});
