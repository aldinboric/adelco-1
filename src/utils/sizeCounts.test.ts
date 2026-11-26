import { describe, expect, it } from 'vitest';
import * as shared from '../../shared/sizeCounts.ts';
import { sizeCountLabel, sizesColumnLines } from './sizeCounts.ts';

// The Sizes-column logic itself is tested in shared/sizeCounts.test.ts; this only pins
// that the utils re-export serves the one shared implementation to the components.
describe('utils/sizeCounts re-export', () => {
  it('serves the shared implementation', () => {
    expect(sizesColumnLines).toBe(shared.sizesColumnLines);
    expect(sizeCountLabel).toBe(shared.sizeCountLabel);
  });
});
