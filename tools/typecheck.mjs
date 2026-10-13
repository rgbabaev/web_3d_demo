#!/usr/bin/env node
// Serialized `tsc --noEmit`; see lock.mjs.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLock } from './lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const code = await withLock('typecheck', () => {
  const r = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], { cwd: root, stdio: 'inherit' });
  return r.status ?? 1;
});
if (code === 0) console.log('typecheck: OK');
process.exit(code);
