#!/usr/bin/env node
// Prints a file with comments and blank lines stripped, so two revisions can be
// compared for code equality after a comment-only edit.
import { readFileSync } from 'node:fs';

const src = readFileSync(process.argv[2], 'utf8');
let out = '';
let i = 0;
let state = 'code';
while (i < src.length) {
  const c = src[i];
  const n = src[i + 1];
  if (state === 'code') {
    if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
    if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { state = c; out += c; i++; continue; }
    out += c; i++; continue;
  }
  if (state === 'line') { if (c === '\n') { state = 'code'; out += '\n'; } i++; continue; }
  if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i += 2; } else i++; continue; }
  // inside a string literal
  if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
  out += c;
  if (c === state) state = 'code';
  i++;
}
console.log(out.split('\n').map((l) => l.trim()).filter(Boolean).join('\n'));
