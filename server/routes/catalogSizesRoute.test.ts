// Integration test for POST /api/products/:id/materials/:materialId/sizes — the endpoint
// behind "add a size without leaving the quote". Boots the real auth + catalog routers on an
// ephemeral port against a throwaway data directory, so permission gating, validation wording,
// and catalog persistence are all exercised over HTTP.

import express from 'express';
import fs from 'fs';
import type { Server } from 'http';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The data directory is read from the env at module load, so point it at a throwaway dir
// before importing anything that touches the database.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adelco-route-'));
process.env.ADELCO_DATA_DIR = dataDir;

const { createAuthRouter } = await import('./authRoutes.ts');
const { createCatalogRouter } = await import('./catalogRoutes.ts');
const { ensureInitialAdminUser } = await import('../auth.ts');
const { closeDb, getDb } = await import('../db.ts');

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

async function login(username: string, password: string): Promise<string> {
  const res = await api('/auth/login', { method: 'POST', body: { username, password } });
  expect(res.status).toBe(200);
  expect(res.cookie).toBeTruthy();
  return res.cookie!;
}

describe('POST /api/products/:id/materials/:materialId/sizes', () => {
  it('adds a size to the catalog, refuses duplicates with the editor message, and gates on products_manage', async () => {
    const adminCookie = await login('admin', 'admin');

    // A product whose Aluminum type has one Size, created the way the catalog editor does.
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

    // Unauthenticated requests are rejected.
    const anon = await api(`/products/${productId}/materials/${materialId}/sizes`, {
      method: 'POST',
      body: { price_per_lf_cents: 700, width_in: 5, length_ft: 10 },
    });
    expect(anon.status).toBe(401);

    // Happy path: a second Size is written to the catalog and returned with the updated Type.
    const added = await api(`/products/${productId}/materials/${materialId}/sizes`, {
      method: 'POST',
      cookie: adminCookie,
      body: { price_per_lf_cents: 700, gauge: '26', width_in: 5, length_ft: 10 },
    });
    expect(added.status).toBe(201);
    expect(added.body.size).toMatchObject({
      material_id: materialId,
      price_per_lf_cents: 700,
      gauge: '26',
      width_in: 5,
      length_ft: 10,
    });
    expect(added.body.material.sizes.map((s: any) => s.id)).toEqual([
      created.body.materials[0].sizes[0].id,
      added.body.size.id,
    ]);
    // The Type already had Sizes, so its general Price still mirrors the first one.
    expect(added.body.material.price_per_lf_cents).toBe(500);

    // A duplicate label (different case) is refused with the catalog editor's message.
    const dup = await api(`/products/${productId}/materials/${materialId}/sizes`, {
      method: 'POST',
      cookie: adminCookie,
      body: { price_per_lf_cents: 900, gauge: '26 GA', width_in: 5, length_ft: 10 },
    });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toBe(`Duplicate size "26 GA 5" x 10'" for material type "Aluminum".`);

    // No Dimension at all is refused, numbered after the two existing Sizes.
    const noDims = await api(`/products/${productId}/materials/${materialId}/sizes`, {
      method: 'POST',
      cookie: adminCookie,
      body: { price_per_lf_cents: 900 },
    });
    expect(noDims.status).toBe(400);
    expect(noDims.body.error).toBe('Size #3 of "Aluminum" needs at least one of gauge, width, or length.');

    // A non-positive width is refused.
    const badWidth = await api(`/products/${productId}/materials/${materialId}/sizes`, {
      method: 'POST',
      cookie: adminCookie,
      body: { price_per_lf_cents: 900, width_in: -1 },
    });
    expect(badWidth.status).toBe(400);
    expect(badWidth.body.error).toBe('Width (in) for Size #3 of "Aluminum" must be a positive number.');

    // An unknown product/material pairing is a 404, and an invalid id a 400.
    const wrongProduct = await api(`/products/9999/materials/${materialId}/sizes`, {
      method: 'POST',
      cookie: adminCookie,
      body: { price_per_lf_cents: 100, width_in: 6 },
    });
    expect(wrongProduct.status).toBe(404);
    const badId = await api(`/products/abc/materials/${materialId}/sizes`, {
      method: 'POST',
      cookie: adminCookie,
      body: { price_per_lf_cents: 100, width_in: 6 },
    });
    expect(badId.status).toBe(400);

    // Persistence: every later quote reads the new Size from the catalog.
    const list = await api('/products', { cookie: adminCookie });
    const product = list.body.find((p: any) => p.id === productId);
    expect(product.materials[0].sizes.map((s: any) => s.length_ft)).toEqual([5, 10]);

    // A user without the catalog-manage (products_manage) permission is refused...
    const createdUser = await api('/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        username: 'quoter',
        display_name: 'Quoter',
        password: 'quoter-pass-123',
        role: 'user',
        permissions: { customer_quote: true, products_view: true, products_manage: false },
      },
    });
    expect(createdUser.status).toBe(201);
    const quoterCookie = await login('quoter', 'quoter-pass-123');
    // ...can still read the catalog for quoting...
    expect((await api('/products', { cookie: quoterCookie })).status).toBe(200);
    // ...but cannot add a Size.
    const forbidden = await api(`/products/${productId}/materials/${materialId}/sizes`, {
      method: 'POST',
      cookie: quoterCookie,
      body: { price_per_lf_cents: 100, width_in: 6 },
    });
    expect(forbidden.status).toBe(403);

    // The refused write changed nothing.
    const after = await api('/products', { cookie: adminCookie });
    const afterProduct = after.body.find((p: any) => p.id === productId);
    expect(afterProduct.materials[0].sizes).toHaveLength(2);
  });

  it("mirrors the first Size's Price into the Material Type when the Type had no Sizes", async () => {
    const adminCookie = await login('admin', 'admin');

    const form = new FormData();
    form.append('name', 'Downpipes');
    form.append('materials', JSON.stringify([{ name: 'Aluminum', price_per_lf_cents: 900 }]));
    const created = await api('/products', { method: 'POST', form, cookie: adminCookie });
    expect(created.status).toBe(201);
    const productId = created.body.id as number;
    const materialId = created.body.materials[0].id as number;

    const added = await api(`/products/${productId}/materials/${materialId}/sizes`, {
      method: 'POST',
      cookie: adminCookie,
      body: { price_per_lf_cents: 700, width_in: 6 },
    });
    expect(added.status).toBe(201);
    expect(added.body.material.price_per_lf_cents).toBe(700);
    expect(added.body.material.sizes).toHaveLength(1);
  });
});
