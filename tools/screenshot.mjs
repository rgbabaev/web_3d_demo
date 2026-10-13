#!/usr/bin/env node
// Headless screenshot of the scene. Flags are documented in README.md.
// Chromium runs on SwiftShader, so a frame takes tens of seconds.
import { spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLock } from './lock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const view = opt('view', 'overview');
const preset = opt('preset', 'golden');
const width = Number(opt('width', '1280'));
const height = Number(opt('height', '720'));
const quality = opt('quality', 'high');
const outArg = opt('out', null);
const all = flag('all');
const moduleName = opt('module', null);
const views = all ? ['overview', 'desk', 'sofa', 'window'] : [view];
const extraQuery = ['y', 'az', 'el', 'zoom'].filter((k) => opt(k, null) !== null).map((k) => `&${k}=${encodeURIComponent(opt(k))}`).join('');

function probe(url) {
  return new Promise((resolveProbe) => {
    const req = httpRequest(url, { method: 'GET', timeout: 1500 }, (res) => { res.resume(); resolveProbe(res.statusCode < 500); });
    req.on('error', () => resolveProbe(false));
    req.on('timeout', () => { req.destroy(); resolveProbe(false); });
    req.end();
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

async function resolveBaseUrl() {
  const explicit = opt('url', null);
  if (explicit) return { base: explicit.replace(/\/$/, ''), close: () => {} };
  if (!flag('build')) {
    for (const candidate of ['http://127.0.0.1:5175', 'http://localhost:5175']) {
      if (await probe(candidate + '/')) {
        console.log(`[shot] using dev server at ${candidate}`);
        return { base: candidate, close: () => {} };
      }
    }
  }
  console.log('[shot] building…');
  const r = spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  const dist = join(root, 'dist');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = join(dist, decodeURIComponent(url.pathname));
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r2) => server.listen(0, '127.0.0.1', r2));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const exitCode = await withLock('screenshot', async () => {
  const { base, close } = await resolveBaseUrl();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  let failed = false;
  try {
    for (const v of views) {
      const defaultName = moduleName ? `module-${moduleName}.png` : `${v}-${preset}.png`;
      const out = outArg && !all ? outArg : join(root, 'shots', defaultName);
      mkdirSync(dirname(resolve(root, out)), { recursive: true });
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      const errors = [];
      const logs = [];
      page.on('console', (m) => {
        const text = m.text();
        if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${text}`);
        else if (text.startsWith('[module]')) logs.push(text);
      });
      page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
      const url = `${base}/?shot=1&view=${v}&preset=${preset}&quality=${quality}&dpr=1${moduleName ? `&module=${encodeURIComponent(moduleName)}` : ''}${extraQuery}`;
      const t0 = Date.now();
      await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
      try {
        await page.waitForFunction(() => window.__scene?.ready === true, null, { timeout: 240_000, polling: 250 });
      } catch (e) {
        const text = await page.evaluate(() => document.getElementById('loading-text')?.textContent ?? '').catch(() => '');
        console.log(`[shot] FAILED waiting for scene: ${e.message.split('\n')[0]} — page says: ${text}`);
        for (const err of errors) console.log('   ' + err);
        failed = true;
        await page.close();
        continue;
      }
      await page.waitForTimeout(300);
      const dataUrl = await page.evaluate(() => window.__scene.capture());
      const stats = await page.evaluate(() => window.__scene.stats());
      writeFileSync(resolve(root, out), Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`[shot] ${moduleName ? 'module ' + moduleName : v + '/' + preset} → ${out}  (${((Date.now() - t0) / 1000).toFixed(1)}s, ${stats.drawCalls} draw calls, ${stats.triangles.toLocaleString()} tris, ${stats.textures} textures)`);
      if (stats.self) console.log(`   THIS MODULE ONLY: ${stats.self.drawCalls} draw calls, ${stats.self.triangles.toLocaleString()} triangles, ${stats.self.meshes} meshes  <- check against the budget`);
      if (stats.bbox) console.log(`   bbox min (${stats.bbox.slice(0, 3).join(', ')}) max (${stats.bbox.slice(3).join(', ')})`);
      if (stats.lights?.length) console.log(`   registered lights: ${stats.lights.join(', ')}`);
      for (const l of logs) console.log('   ' + l);
      for (const e of errors) console.log('   ' + e);
      if (errors.some((e) => e.startsWith('[error]') || e.startsWith('[pageerror]'))) failed = true;
      await page.close();
    }
  } finally {
    await browser.close();
    close();
  }
  return failed ? 1 : 0;
});
process.exit(exitCode);
