import { describe, expect, it } from 'vitest';
import { isPreview, productStatus, productStatusLabel } from './preview.ts';

const aluminum = { name: 'Aluminum' };
const wood = { name: 'Wood' };

describe('productStatus', () => {
  it('reads Available for a Product with Material Types that is in stock', () => {
    expect(productStatusLabel(productStatus([aluminum], true))).toBe('Available');
  });

  it('reads Unavailable for a Product with Material Types that is out of stock', () => {
    expect(productStatusLabel(productStatus([aluminum, wood], false))).toBe('Unavailable');
  });

  it('reads Preview for a Product with no Material Types', () => {
    expect(productStatusLabel(productStatus([], true))).toBe('Preview');
  });

  it('reads Preview even while the Product is also marked Unavailable', () => {
    expect(productStatusLabel(productStatus([], false))).toBe('Preview');
  });
});

describe('isPreview', () => {
  it('holds for a Product with no Material Types', () => {
    expect(isPreview([])).toBe(true);
  });

  it('does not hold once the Product has its first Material Type', () => {
    expect(isPreview([aluminum])).toBe(false);
    expect(isPreview([aluminum, wood])).toBe(false);
  });
});
