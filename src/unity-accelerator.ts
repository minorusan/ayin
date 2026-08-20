/**
 * unity-accelerator.ts — keep a watched Unity project pointed at the Accelerator.
 *
 * The Accelerator is a shared asset-import cache. A project that is not pointed at it re-imports
 * everything locally, which is the slowest thing a Unity developer does all day. Unity stores the
 * pointer in `ProjectSettings/EditorSettings.asset` as two fields, so keeping it set is a two-line
 * edit — the work here is entirely in NOT doing that edit at the wrong moment.
 *
 * THE ENDPOINT IS CONFIG, NEVER SOURCE. `acceleratorEndpoint` defaults to EMPTY and empty means
 * disabled: no probe, no read, no write. A LAN address in this file would be a fact about one
 * machine compiled into a public repo, which CLAUDE.md §4 forbids outright — and it would be wrong
 * for every other machine besides.
 *
 * IT IS WRITTEN ONLY WHILE THE BOX ANSWERS. "If available" is load-bearing rather than polite: Unity
 * pointed at a dead cache server does not fail fast, it waits on every import, so asserting an
 * unreachable endpoint makes the editor slower than leaving it unset. A TCP connect with a short
 * timeout is the whole check — the Accelerator's own HTTP identity is not needed to know a socket
 * opened.
 *
 * AND IT NEVER REVERTS. When the box stops answering the setting is LEFT ALONE, not cleared. This
 * file is tracked, so an automatic revert would mean a daemon adding and removing a line in version
 * control as a laptop moves between networks — churn in `git status` that the operator did not cause
 * and cannot predict. Asserting is a decision the operator made once; un-asserting is theirs too.
 *
 * KNOWN COST, ACCEPTED BY THE OPERATOR. `ProjectSettings/EditorSettings.asset` is tracked and shared,
 * so once this writes, the file is dirty until it is committed — and if it IS committed, every
 * teammate and every CI runner inherits an endpoint that does not resolve for them. That trade was
 * raised and chosen deliberately; it is recorded here so the next reader does not have to rediscover
 * it. The machine-local alternative is Unity's own user preference, which `m_CacheServerMode: 0`
 * already defers to.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { getConfigString } from './prompts.js';
import { log } from './log.js';

/** Long enough for a LAN box under load, short enough not to stall a five-minute self-heal. */
const PROBE_TIMEOUT_MS = 1_500;

/** `host:port`, and nothing that could be a shell or a URL. Operator config is still validated. */
const ENDPOINT_RE = /^([A-Za-z0-9._-]{1,253}):(\d{1,5})$/;

export function acceleratorEndpoint(): string {
  return (process.env.AYIN_ACCELERATOR || getConfigString('acceleratorEndpoint') || '').trim();
}

export function parseEndpoint(ep: string): { host: string; port: number } | null {
  const m = ENDPOINT_RE.exec(ep);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port <= 65535 ? { host: m[1], port } : null;
}

/** Did a socket open? That is the entire question — no HTTP, no identity check, no dependency. */
export function reachable(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => { if (!done) { done = true; resolve(ok); } };
    const sock = createConnection({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { sock.destroy(); finish(true); });
    sock.once('timeout', () => { sock.destroy(); finish(false); });
    sock.once('error', () => { sock.destroy(); finish(false); });
  });
}

const SETTINGS_REL = join('ProjectSettings', 'EditorSettings.asset');

export interface AcceleratorResult {
  /** Did the file change? */
  wrote: boolean;
  /** What happened, always. A silent no-op is indistinguishable from a broken feature. */
  why: string;
}

/**
 * Set the two cache-server fields, preserving every other byte of the file.
 *
 * A LINE EDIT, not a YAML round-trip. Unity's `.asset` files are its own YAML dialect with tags and
 * ordering it depends on; re-serializing them through a general parser is how a settings file comes
 * back subtly different and Unity rewrites half of it. Only the two lines that must change are
 * touched, and only when their value is not already what it should be.
 */
export function applyToSettings(repo: string, endpoint: string): AcceleratorResult {
  const path = join(repo, SETTINGS_REL);
  if (!existsSync(path)) return { wrote: false, why: `${SETTINGS_REL} not found — not a Unity project` };
  let text: string;
  try { text = readFileSync(path, 'utf-8'); }
  catch (e) { return { wrote: false, why: `unreadable: ${e instanceof Error ? e.message : String(e)}` }; }

  const lines = text.split('\n');
  let sawMode = false, sawEndpoint = false, changed = false;
  for (let i = 0; i < lines.length; i++) {
    const mode = /^(\s*m_CacheServerMode:\s*)(.*)$/.exec(lines[i]);
    if (mode) {
      sawMode = true;
      if (mode[2].trim() !== '1') { lines[i] = `${mode[1]}1`; changed = true; }
      continue;
    }
    const ep = /^(\s*m_CacheServerEndpoint:\s*)(.*)$/.exec(lines[i]);
    if (ep) {
      sawEndpoint = true;
      if (ep[2].trim() !== endpoint) { lines[i] = `${ep[1]}${endpoint}`; changed = true; }
    }
  }
  // A project whose settings file predates these fields is not one to invent them in: the field names
  // and their order are Unity's, and appending a guess is how a settings file stops loading.
  if (!sawMode || !sawEndpoint) {
    return { wrote: false, why: `${SETTINGS_REL} has no m_CacheServer* fields — left untouched` };
  }
  if (!changed) return { wrote: false, why: `already pointed at ${endpoint}` };
  try {
    writeFileSync(path, lines.join('\n'));
    log('INFO', 'accelerator_set', { repo, endpoint });
    return { wrote: true, why: `pointed at ${endpoint}` };
  } catch (e) {
    return { wrote: false, why: `write failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The whole policy, for `ayin watch` install and for every self-heal.
 *
 * Ordered so the cheapest refusal comes first: unset config costs nothing, a malformed endpoint costs
 * a regex, a non-Unity repo costs a stat, and only then is a socket opened.
 */
export async function ensureAccelerator(repo: string): Promise<AcceleratorResult> {
  const ep = acceleratorEndpoint();
  if (!ep) return { wrote: false, why: 'no acceleratorEndpoint configured — disabled' };
  const parsed = parseEndpoint(ep);
  if (!parsed) return { wrote: false, why: `acceleratorEndpoint "${ep}" is not host:port` };
  if (!existsSync(join(repo, SETTINGS_REL))) {
    return { wrote: false, why: 'not a Unity project' };
  }
  if (!(await reachable(parsed.host, parsed.port))) {
    // Left as it is, deliberately — see the header. Unity waits on a dead cache server, and a daemon
    // that clears the field would churn a tracked file every time a laptop changed network.
    return { wrote: false, why: `${ep} did not answer — setting left as it is` };
  }
  return applyToSettings(repo, ep);
}
