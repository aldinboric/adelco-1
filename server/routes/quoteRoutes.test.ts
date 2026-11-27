// Integration test for the size label on issued quotes: the quote snapshots the Size's
// Dimensions at issue time, and every later render (API detail, Excel/PDF export, print
// preview) re-derives the one shared label from that snapshot — so editing the catalog or
// removing the Size afterwards never changes what the issued quote prints.
// Boots the real auth + catalog + quote routers on an ephemeral port against a throwaway
// data directory, like the catalog sizes route test.

import AdmZip from 'adm-zip';
import express from 'express';
import fs from 'fs';
import type { Server } from 'http';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The data directory is read from the env at module load, so point it at a throwaway dir
// before importing anything that touches the database.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adelco-quote-route-'));
process.env.ADELCO_DATA_DIR = dataDir;

const { createAuthRouter } = await import('./authRoutes.ts');
const { createCatalogRouter } = await import('./catalogRoutes.ts');
const { createQuoteRouter } = await import('./quoteRoutes.ts');
const { ensureInitialAdminUser } = await import('../auth.ts');
const { closeDb, getDb } = await import('../db.ts');
const { formatMaterialSizeLine } = await import('../../shared/size.ts');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  ensureInitialAdminUser();
  // The seeded admin is locked until it changes its password; clear the flag directly.
  getDb().prepare('UPDATE users SET must_change_password = 0 WHERE username = ?').run('admin');

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createAuthRouter());
  app.use('/api', createCatalogRouter());
  app.use('/api', createQuoteRouter());

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function api(
  path: string,
  init: { method?: string; body?: unknown; form?: FormData; cookie?: string } = {}
): Promise<{ status: number; body: any; cookie?: string }> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers['Cookie'] = init.cookie;
  let body: BodyInit | undefined;
  if (init.form) {
    body = init.form;
  } else if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${baseUrl}/api${path}`, { method: init.method ?? 'GET', headers, body });
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    cookie: setCookie ? setCookie.split(';')[0] : undefined,
  };
}

async function apiBuffer(
  path: string,
  cookie: string
): Promise<{ status: number; contentType: string | null; buf: Buffer }> {
  const res = await fetch(`${baseUrl}/api${path}`, { headers: { Cookie: cookie } });
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    buf: Buffer.from(await res.arrayBuffer()),
  };
}

async function login(username: string, password: string): Promise<string> {
  const res = await api('/auth/login', { method: 'POST', body: { username, password } });
  expect(res.status).toBe(200);
  expect(res.cookie).toBeTruthy();
  return res.cookie!;
}

/** Every XML part of an .xlsx buffer, as text — for asserting on cell strings. */
function xlsxText(buf: Buffer): string {
  const zip = new AdmZip(buf);
  return zip
    .getEntries()
    .map((e) => e.getData().toString('utf8'))
    .join('\n');
}

describe('issued quote size label', () => {
  it('keeps rendering the sold Size after the catalog edits it away, in the API and the exports', async () => {
    const adminCookie = await login('admin', 'admin');

    const color = await api('/colors', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: 'Charcoal', hex_code: '#333333', price_per_lf_cents: 100 },
    });
    expect(color.status).toBe(201);
    const colorId = color.body.id as number;

    // Fascia / Aluminum with one Size: 26 ga, 5" x 5' at $5.00/lf.
    const form = new FormData();
    form.append('name', 'Fascia');
    form.append(
      'materials',
      JSON.stringify([
        {
          name: 'Aluminum',
          sizes: [{ price_per_lf_cents: 500, gauge: '26', width_in: 5, length_ft: 5 }],
        },
      ])
    );
    const created = await api('/products', { method: 'POST', form, cookie: adminCookie });
    expect(created.status).toBe(201);
    const productId = created.body.id as number;
    const materialId = created.body.materials[0].id as number;
    const sizeId = created.body.materials[0].sizes[0].id as number;

    // Issue a quote selling that Size.
    const quoteDate = new Date().toISOString().slice(0, 10);
    const issued = await api('/quotes', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        quote_date: quoteDate,
        customer_name: 'Test Customer',
        items: [
          {
            product_id: productId,
            material_type: 'Aluminum',
            size_id: sizeId,
            color_id: colorId,
            linear_feet: 10,
          },
        ],
      },
    });
    expect(issued.status).toBe(201);
    const quoteId = issued.body.quote.id as number;
    expect(issued.body.items[0]).toMatchObject({
      material_type: 'Aluminum',
      gauge: '26',
      width_in: 5,
      length_ft: 5,
    });

    // Edit the catalog: the Size the quote sold is replaced by a different one.
    const editForm = new FormData();
    editForm.append('name', 'Fascia');
    editForm.append(
      'materials',
      JSON.stringify([
        {
          name: 'Aluminum',
          sizes: [{ price_per_lf_cents: 900, gauge: '24', width_in: 6, length_ft: 8 }],
        },
      ])
    );
    const edited = await api(`/products/${productId}`, {
      method: 'PUT',
      form: editForm,
      cookie: adminCookie,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.materials[0].sizes).toHaveLength(1);
    expect(edited.body.materials[0].sizes[0].gauge).toBe('24');

    // The issued quote's stored Line still carries the sold Dimensions...
    const detail = await api(`/quotes/${quoteId}`, { cookie: adminCookie });
    expect(detail.status).toBe(200);
    const line = detail.body.items[0];
    expect(line.material_type).toBe('Aluminum');
    expect(line.gauge).toBe('26');
    expect(line.width_in).toBe(5);
    expect(line.length_ft).toBe(5);
    // ...and the one shared label renders it exactly as sold — what the PDF, the print
    // preview, and the spreadsheets all print beside the material type.
    expect(formatMaterialSizeLine(line.material_type, line)).toBe(`Aluminum (26 ga 5" x 5')`);

    // The Excel export's measures column carries the sold Size, not the edited catalog one.
    const excel = await apiBuffer(`/quotes/${quoteId}/export/excel`, adminCookie);
    expect(excel.status).toBe(200);
    const cells = xlsxText(excel.buf);
    expect(cells).toContain('26 ga 5');
    expect(cells).not.toContain('24 ga 6');

    // The PDF export still builds and serves.
    const pdf = await apiBuffer(`/quotes/${quoteId}/export/pdf`, adminCookie);
    expect(pdf.status).toBe(200);
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Sanity: the catalog really is edited — the product now sells only the new Size.
    const list = await api('/products', { cookie: adminCookie });
    expect(list.status).toBe(200);
    const product = list.body.find((p: any) => p.id === productId);
    expect(product.materials[0].sizes.map((s: any) => s.gauge)).toEqual(['24']);
  });
});

describe('copying an issued quote re-resolves Sizes (#6)', () => {
  it('re-resolves a Size that still exists silently, and flags one the catalog deleted', async () => {
    const adminCookie = await login('admin', 'admin');

    const color = await api('/colors', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: 'Slate', hex_code: '#444444', price_per_lf_cents: 100 },
    });
    expect(color.status).toBe(201);
    const colorId = color.body.id as number;

    // Fascia / Aluminum with two Sizes: 26 ga 5" x 5' and 24 ga 6" x 8'.
    const form = new FormData();
    form.append('name', 'Fascia Copy');
    form.append(
      'materials',
      JSON.stringify([
        {
          name: 'Aluminum',
          sizes: [
            { price_per_lf_cents: 500, gauge: '26', width_in: 5, length_ft: 5 },
            { price_per_lf_cents: 900, gauge: '24', width_in: 6, length_ft: 8 },
          ],
        },
      ])
    );
    const created = await api('/products', { method: 'POST', form, cookie: adminCookie });
    expect(created.status).toBe(201);
    const productId = created.body.id as number;
    const sizes = created.body.materials[0].sizes as Array<{ id: number }>;
    expect(sizes).toHaveLength(2);

    // Issue a quote with one Line per Size.
    const issued = await api('/quotes', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        quote_date: new Date().toISOString().slice(0, 10),
        customer_name: 'Copy Customer',
        items: [
          { product_id: productId, material_type: 'Aluminum', size_id: sizes[0].id, color_id: colorId, linear_feet: 10 },
          { product_id: productId, material_type: 'Aluminum', size_id: sizes[1].id, color_id: colorId, linear_feet: 12 },
        ],
      },
    });
    expect(issued.status).toBe(201);
    const quoteId = issued.body.quote.id as number;

    // The catalog drops the second Size (the re-save re-inserts the first with a new id).
    const editForm = new FormData();
    editForm.append('name', 'Fascia Copy');
    editForm.append(
      'materials',
      JSON.stringify([
        {
          name: 'Aluminum',
          sizes: [{ price_per_lf_cents: 500, gauge: '26', width_in: 5, length_ft: 5 }],
        },
      ])
    );
    const edited = await api(`/products/${productId}`, { method: 'PUT', form: editForm, cookie: adminCookie });
    expect(edited.status).toBe(200);
    const keptSizeId = edited.body.materials[0].sizes[0].id as number;
    expect(keptSizeId).not.toBe(sizes[0].id);

    const copy = await api(`/quotes/${quoteId}/copy`, { method: 'POST', cookie: adminCookie });
    expect(copy.status).toBe(200);
    expect(copy.body.source_quote_number).toBe(issued.body.quote.quote_number);
    expect(copy.body.items).toHaveLength(2);

    // The Size that still exists is re-resolved silently to its current id.
    expect(copy.body.items[0].sizeResolution).toEqual({
      size_id: keptSizeId,
      sizeIssue: null,
      fallbackSizeLabel: null,
    });

    // The deleted Size is flagged, carrying the label it was sold at.
    expect(copy.body.items[1].sizeResolution).toEqual({
      size_id: null,
      sizeIssue: 'deleted',
      fallbackSizeLabel: `24 ga 6" x 8'`,
    });
  });
});
