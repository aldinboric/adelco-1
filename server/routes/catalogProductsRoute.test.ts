// Integration test for the Preview guard on POST/PUT /api/products (#5): saving a
// product with no material types is only accepted when the request explicitly carries
// saveAsPreview — a non-UI client cannot silently create or demote to a Preview. Boots
// the real auth + catalog routers on an ephemeral port against a throwaway data directory.

import express from 'express';
import fs from 'fs';
import type { Server } from 'http';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The data directory is read from the env at module load, so point it at a throwaway dir
// before importing anything that touches the database.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adelco-products-route-'));
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

describe('Preview guard on POST/PUT /api/products (#5)', () => {
  it('rejects empty materials with 400 unless saveAsPreview is explicit — on create and on edit', async () => {
    const adminCookie = await login('admin', 'admin');

    // Create with no material types and no flag: refused, so a non-UI client cannot
    // silently create a Preview.
    const form = new FormData();
    form.append('name', 'Bare Product');
    form.append('materials', JSON.stringify([]));
    const rejected = await api('/products', { method: 'POST', form, cookie: adminCookie });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/preview/i);

    // Create with the explicit flag (multipart form): accepted, and saved as a Preview.
    const previewForm = new FormData();
    previewForm.append('name', 'Bare Product');
    previewForm.append('materials', JSON.stringify([]));
    previewForm.append('saveAsPreview', 'true');
    const created = await api('/products', { method: 'POST', form: previewForm, cookie: adminCookie });
    expect(created.status).toBe(201);
    expect(created.body.materials).toEqual([]);
    const productId = created.body.id as number;

    // A JSON client sends the same flag as a boolean.
    const jsonCreated = await api('/products', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: 'Bare JSON Product', materials: [], saveAsPreview: true },
    });
    expect(jsonCreated.status).toBe(201);
    expect(jsonCreated.body.materials).toEqual([]);

    // Edit: give the product a material type...
    const withMat = new FormData();
    withMat.append('name', 'Bare Product');
    withMat.append('materials', JSON.stringify([{ name: 'Aluminum', price_per_lf_cents: 500 }]));
    const edited = await api(`/products/${productId}`, { method: 'PUT', form: withMat, cookie: adminCookie });
    expect(edited.status).toBe(200);
    expect(edited.body.materials).toHaveLength(1);

    // ...then remove every material type without the flag: refused (no silent demotion)...
    const stripForm = new FormData();
    stripForm.append('name', 'Bare Product');
    stripForm.append('materials', JSON.stringify([]));
    const stripped = await api(`/products/${productId}`, { method: 'PUT', form: stripForm, cookie: adminCookie });
    expect(stripped.status).toBe(400);
    expect(stripped.body.error).toMatch(/preview/i);

    // ...and with the flag: accepted, demoted to a Preview.
    const stripPreview = new FormData();
    stripPreview.append('name', 'Bare Product');
    stripPreview.append('materials', JSON.stringify([]));
    stripPreview.append('saveAsPreview', 'true');
    const demoted = await api(`/products/${productId}`, { method: 'PUT', form: stripPreview, cookie: adminCookie });
    expect(demoted.status).toBe(200);
    expect(demoted.body.materials).toEqual([]);
  });
});
