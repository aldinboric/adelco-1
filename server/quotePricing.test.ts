import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A throwaway data directory: the modules under test read it on first import, and the
// database it holds is opened and dropped like any other deployment's would be.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adelco-quote-'));
process.env.ADELCO_DATA_DIR = dataDir;

let db: import('better-sqlite3').Database;
let validateAndBuildQuoteLines: typeof import('./validation.ts').validateAndBuildQuoteLines;
let closeDb: typeof import('./db.ts').closeDb;
let colorId: number;
let fasciaWithMaterialId: number;
let panelWithoutMaterialsId: number;

beforeAll(async () => {
  const dbModule = await import('./db.ts');
  const validation = await import('./validation.ts');
  validateAndBuildQuoteLines = validation.validateAndBuildQuoteLines;
  closeDb = dbModule.closeDb;
  db = dbModule.getDb();

  const now = new Date().toISOString();
  colorId = Number(
    db
      .prepare(
        'INSERT INTO metal_colors (name, hex_code, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, ?, ?, 1, 0, ?)'
      )
      .run('Charcoal', '#333333', 100, now).lastInsertRowid
  );

  // A product that predates Sizes: one material row carrying Dimensions and a Price.
  fasciaWithMaterialId = Number(
    db
      .prepare(
        'INSERT INTO metal_products (name, image_path, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, NULL, ?, 1, 0, ?)'
      )
      .run('Fascia', 1200, now).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO product_materials (product_id, name, price_per_lf_cents, width_in, gauge, length_ft, sort_order, created_at)
     VALUES (?, 'Aluminum', 500, 5, '26', 5, 0, ?)`
  ).run(fasciaWithMaterialId, now);

  // A product with no Material Types at all: its own Price is the only one it has.
  panelWithoutMaterialsId = Number(
    db
      .prepare(
        'INSERT INTO metal_products (name, image_path, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, NULL, ?, 1, 1, ?)'
      )
      .run('Ribbed Roof Panel', 425, now).lastInsertRowid
  );
});

afterAll(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function quoteLine(productId: number, extra: Record<string, unknown> = {}) {
  return {
    product_id: productId,
    color_id: colorId,
    linear_feet: 10,
    ...extra,
  };
}

describe('quoting products that predate Sizes', () => {
  it("prices a line from the selected Material Type while it has no Sizes of its own", () => {
    const { items } = validateAndBuildQuoteLines(
      [quoteLine(fasciaWithMaterialId, { material_type: 'Aluminum', width_in: 5, gauge: '26', length_ft: 5 })],
      { requireAvailable: true }
    );

    expect(items[0].material_type).toBe('Aluminum');
    expect(items[0].product_price_per_lf_cents).toBe(500);
    expect(items[0].line_total_cents).toBe(6000);
  });

  it('prices a product with no Material Types from its own Price', () => {
    const { items } = validateAndBuildQuoteLines([quoteLine(panelWithoutMaterialsId)], { requireAvailable: true });

    expect(items[0].material_type).toBeNull();
    expect(items[0].product_price_per_lf_cents).toBe(425);
    expect(items[0].line_total_cents).toBe(5250);
  });
});
