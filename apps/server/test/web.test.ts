import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { authedApp, tempDataDir } from './helpers.js';

describe('serving the web app', () => {
  it('serves assets, falls back to index.html for client routes and keeps API 404s', async () => {
    const dirs = tempDataDir('pca-web-');
    const webDir = path.join(dirs.dataDir, 'web');
    fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(webDir, 'assets', 'app-123.js'), 'console.log(1)');
    fs.writeFileSync(path.join(webDir, 'sw.js'), '// sw');
    const { app, headers } = await authedApp({ ...dirs, webDir });
    try {
      const asset = await app.inject('/assets/app-123.js');
      expect(asset.headers['cache-control']).toContain('immutable');
      const sw = await app.inject('/sw.js');
      expect(sw.headers['cache-control']).toBe('no-cache');
      const route = await app.inject('/read/abc?page=2');
      expect(route.statusCode).toBe(200);
      expect(route.body).toContain('id="root"');
      expect(route.headers['x-frame-options']).toBe('DENY');
      const api = await app.inject({ url: '/api/nope', headers });
      expect(api.statusCode).toBe(404);
      expect(api.json()).toEqual({ error: 'not_found' });
    } finally {
      await app.close();
    }
  });
});
