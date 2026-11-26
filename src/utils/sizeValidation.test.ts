import { describe, expect, it } from 'vitest';
import { MAX_DIMENSION_VALUE, validateSizeRow, type SizeFormInput } from './sizeValidation.ts';

const blank: SizeFormInput = { price: '', width: '', gauge: '', length: '' };

/** The rendered labels a Material Type already has, as the in-quote form seeds them. */
function labelsOf(...labels: (string | null)[]): Set<string> {
  return new Set(labels.filter((l): l is string => Boolean(l)).map((l) => l.toLowerCase()));
}

describe('validateSizeRow (shared by the catalog editor and the in-quote add-size form)', () => {
  it('requires a valid non-negative price', () => {
    const result = validateSizeRow('Aluminum', 3, { ...blank, width: '5' }, new Set());

    expect(result).toEqual({
      ok: false,
      error: 'Size #3 of "Aluminum" needs a valid non-negative price per linear ft.',
    });
  });

  it('rejects a non-positive width', () => {
    const result = validateSizeRow('Aluminum', 1, { ...blank, price: '5', width: '-2' }, new Set());

    expect(result).toEqual({
      ok: false,
      error: 'Width (in) for Size #1 of "Aluminum" must be a positive number.',
    });
  });

  it('rejects a width beyond the sanity ceiling', () => {
    const result = validateSizeRow(
      'Aluminum',
      1,
      { ...blank, price: '5', width: String(MAX_DIMENSION_VALUE + 1) },
      new Set()
    );

    expect(result).toEqual({
      ok: false,
      error: 'Width (in) for Size #1 of "Aluminum" must be a positive number.',
    });
  });

  it('rejects a non-positive length', () => {
    const result = validateSizeRow('Aluminum', 2, { ...blank, price: '5', length: '0' }, new Set());

    expect(result).toEqual({
      ok: false,
      error: 'Length (ft) for Size #2 of "Aluminum" must be a positive number.',
    });
  });

  it('requires at least one Dimension', () => {
    const result = validateSizeRow('Aluminum', 1, { ...blank, price: '5' }, new Set());

    expect(result).toEqual({
      ok: false,
      error: 'Size #1 of "Aluminum" needs at least one of gauge, width, or length.',
    });
  });

  it('refuses a label already claimed, with the catalog editor message', () => {
    const seen = labelsOf('26 ga 5" x 10\'');
    const result = validateSizeRow(
      'Aluminum',
      3,
      { price: '9', gauge: '26', width: '5', length: '10' },
      seen
    );

    expect(result).toEqual({
      ok: false,
      error: `Duplicate size "26 ga 5" x 10'" for material type "Aluminum".`,
    });
  });

  it('compares duplicate labels case-insensitively', () => {
    const seen = labelsOf('26 ga 5" x 10\'');
    const result = validateSizeRow(
      'Aluminum',
      3,
      { price: '9', gauge: '26 GA', width: '5', length: '10' },
      seen
    );

    expect(result).toEqual({
      ok: false,
      error: `Duplicate size "26 GA 5" x 10'" for material type "Aluminum".`,
    });
  });

  it('trims and truncates the gauge like the server does', () => {
    const result = validateSizeRow(
      'Aluminum',
      1,
      { price: '9.50', gauge: '  26  ', width: '', length: '12' },
      new Set()
    );

    expect(result).toEqual({
      ok: true,
      size: { price_per_lf_cents: 950, width_in: null, gauge: '26', length_ft: 12 },
    });
  });

  it('accepts a distinct Size and returns the payload the endpoints receive', () => {
    const seen = new Set<string>();
    const first = validateSizeRow('Aluminum', 1, { ...blank, price: '5', width: '5', length: '5' }, seen);
    const second = validateSizeRow('Aluminum', 2, { ...blank, price: '7', width: '5', length: '10' }, seen);

    expect(first).toEqual({
      ok: true,
      size: { price_per_lf_cents: 500, width_in: 5, gauge: null, length_ft: 5 },
    });
    expect(second).toEqual({
      ok: true,
      size: { price_per_lf_cents: 700, width_in: 5, gauge: null, length_ft: 10 },
    });
  });
});
