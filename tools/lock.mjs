// Cross-process semaphore (mkdir is atomic) bounding how many Chromium/tsc
// processes run at once. The holder touches its slot so a crash is reclaimed
// quickly while a slow render is never stolen from.
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_ROOT = join(tmpdir(), 'scene-tools.lock.d');
const SLOTS = 2;
const STALE_MS = 45_000; // a live holder touches its slot every 5 s
const HEARTBEAT_MS = 5_000;
/** Second slot is only granted above this much free RAM. */
const SECOND_SLOT_FREE_MB = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slotPath(i) {
  return join(LOCK_ROOT, `slot-${i}`);
}

function reapStale() {
  for (let i = 0; i < SLOTS; i++) {
    const p = slotPath(i);
    try {
      if (Date.now() - statSync(p).mtimeMs > STALE_MS) {
        let who = '';
        try { who = readFileSync(join(p, 'owner'), 'utf8').trim(); } catch { /* racing reaper */ }
        rmSync(p, { recursive: true, force: true });
        if (who) console.log(`[lock] reclaimed a stale slot from ${who}`);
      }
    } catch { /* free slot */ }
  }
}

function heldSlots() {
  let n = 0;
  for (let i = 0; i < SLOTS; i++) {
    try { statSync(slotPath(i)); n++; } catch { /* free */ }
  }
  return n;
}

function tryAcquire(label) {
  try { mkdirSync(LOCK_ROOT, { recursive: true }); } catch { /* exists */ }
  reapStale();
  for (let i = 0; i < SLOTS; i++) {
    if (i > 0 && heldSlots() > 0 && freemem() / 1024 / 1024 < SECOND_SLOT_FREE_MB) return null;
    try {
      mkdirSync(slotPath(i));
      writeFileSync(join(slotPath(i), 'owner'), `pid ${process.pid} · ${label}`);
      return i;
    } catch { /* taken, try the next */ }
  }
  return null;
}

export async function withLock(label, fn, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const start = Date.now();
  let slot = null;
  let announced = false;
  for (;;) {
    slot = tryAcquire(label);
    if (slot !== null) break;
    if (!announced) {
      console.log('[lock] waiting for a free render slot…');
      announced = true;
    }
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for a scene tool slot');
    await sleep(1200 + Math.floor(Math.random() * 600)); // jitter so waiters don't sync up
  }

  const dir = slotPath(slot);
  const beat = setInterval(() => {
    try { const t = new Date(); utimesSync(dir, t, t); } catch { /* released */ }
  }, HEARTBEAT_MS);
  beat.unref?.();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    rmSync(dir, { recursive: true, force: true });
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { release(); process.exit(1); });
  process.once('exit', release);

  try {
    return await fn();
  } finally {
    release();
  }
}
