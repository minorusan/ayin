/**
 * QA probes — the DETERMINISTIC half of the QA gate. No LLM, no writes.
 *
 * A reviewer model can read a file and have an opinion about it. It cannot know whether the server
 * is actually listening, whether the README is older than the code it describes, or how many
 * exported symbols a module really has. That is what these probes are for: they gather facts the
 * judge cannot obtain by reading, so the verdict rests on evidence instead of vibes.
 *
 * READ-ONLY BY DESIGN. Nothing here starts a server, writes a file or mutates the repo. When the
 * webview isn't running, the probe SAYS SO and the fix pass (which has bash and the user's
 * permission machinery) is what launches it. A QA step that silently spawns processes would be a
 * side effect nobody asked for, and one nobody could see.
 *
 * NO ENVIRONMENT FACTS IN SOURCE. The LAN address is discovered at runtime from
 * `os.networkInterfaces()`; ports are discovered from the changed files. Nothing about any
 * particular machine is written down here (see the public-repo hygiene rule).
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { llmBaseUrl } from '../connection.js';

// ── what changed ──────────────────────────────────────────────────────

export type FileKind = 'ui' | 'code' | 'doc' | 'config' | 'other';

export interface ChangedFile {
  path: string;
  kind: FileKind;
  exists: boolean;
  bytes: number;
  lines: number;
  mtimeMs: number;
}

const UI_EXT = new Set(['.html', '.htm', '.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.vue', '.svelte', '.dart']);
// `.ino`/`.pde` (Arduino sketches, old and current extension) were missing here, which is not a
// cosmetic gap: an unclassified file gets `kind: 'other'`, and `qaChangedFiles()` DROPS anything of
// kind 'other' from the review entirely — an Arduino sketch was invisible to the gate outright, not
// merely under-reviewed.
const CODE_EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.cs', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.sh', '.zsh', '.mjs', '.ino', '.pde']);
const DOC_EXT = new Set(['.md', '.mdx', '.rst', '.adoc']);
const CONFIG_EXT = new Set(['.json', '.yml', '.yaml', '.toml', '.ini', '.env', '.conf']);

export function classify(path: string): FileKind {
  const ext = extname(path).toLowerCase();
  if (DOC_EXT.has(ext)) return 'doc';
  if (UI_EXT.has(ext)) return 'ui';
  if (CODE_EXT.has(ext)) return 'code';
  if (CONFIG_EXT.has(ext)) return 'config';
  return 'other';
}

/** Stat + classify a path. Missing files are kept (a delete is a change worth reviewing). */
export function describeFile(path: string): ChangedFile {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let bytes = 0;
  let lines = 0;
  let mtimeMs = 0;
  let exists = false;
  try {
    const st = statSync(abs);
    exists = st.isFile();
    bytes = st.size;
    mtimeMs = st.mtimeMs;
    if (exists && bytes < 2 * 1024 * 1024) lines = readFileSync(abs, 'utf-8').split('\n').length;
  } catch { /* gone or unreadable — recorded as exists:false */ }
  return { path: abs, kind: classify(abs), exists, bytes, lines, mtimeMs };
}

/** The project root: the git top-level if there is one, else cwd. */
export function projectRoot(cwd = process.cwd()): string {
  try {
    const out = execSync('git rev-parse --show-toplevel', { cwd, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out) return out;
  } catch { /* not a git repo */ }
  return cwd;
}

/**
 * `git status --porcelain` as a set of absolute paths, or null outside a repo.
 *
 * Used as a BEFORE/AFTER snapshot so changes made through `bash` (a script, a codegen step, a
 * formatter) are reviewed too — tool-parameter tracking alone only sees `write_file`/`str_replace`.
 */
export function gitDirtySet(cwd = process.cwd()): Set<string> | null {
  try {
    const root = projectRoot(cwd);
    // `-unormal` (untracked DIRECTORIES collapsed), not `-uall`: on a tree with a few stale backup
    // directories `-uall` enumerates every file inside them, and this runs twice per turn. The
    // precision isn't missed — files written through tools are tracked by path anyway, and the
    // caller drops anything that isn't an existing file.
    const out = execSync('git status --porcelain --untracked-files=normal', { cwd: root, timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const set = new Set<string>();
    for (const line of out.split('\n')) {
      if (line.length < 4) continue;
      // "XY path" / "XY old -> new" — take the destination for renames.
      const body = line.slice(3).trim();
      const arrow = body.lastIndexOf(' -> ');
      const rel = arrow >= 0 ? body.slice(arrow + 4) : body;
      // `-unormal` prints an untracked DIRECTORY with a trailing slash. Strip it so downstream sees
      // ordinary paths; the caller drops anything that isn't a real file anyway.
      set.add(join(root, rel.replace(/^"|"$/g, '').replace(/\/+$/, '')));
    }
    return set;
  } catch {
    return null;
  }
}

/**
 * Files under `root` modified at or after `sinceMs` — the fallback for when `gitDirtySet()` cannot
 * answer because this is not a git repository.
 *
 * WHY IT EXISTS. `qaChangedFiles()` is tool-tracked writes ∪ git-dirty, and the git half is what
 * catches changes made through `bash` (a heredoc, a script, a formatter). Outside a repo that half
 * returns null, so a turn that wrote every one of its files with `bash` reports ZERO changed files —
 * and `qaShouldRun` then declines with "nothing changed this turn". **The gate does not fail; it
 * silently does not run**, which is strictly worse, and nothing in the output says so.
 *
 * Observed, not theorised: a benchmark project whose files were all written via `bash` in a fresh
 * (non-git) directory shipped a sketch whose filename did not match its folder — it could not compile
 * — and the QA gate never looked at it. Both the naming bar and the compile probe existed and would
 * have caught it on the first pass.
 *
 * Bounded like every other probe here: vendor/build directories skipped, depth capped, count capped.
 * A new project directory is small; this costs a few milliseconds.
 */
export function filesModifiedSince(root: string, sinceMs: number, maxDepth = 5, limit = 200): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (IGNORE_DIR_RE.test(entry)) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (st.mtimeMs >= sinceMs) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

const IGNORE_DIR_RE = /^(node_modules|\.git|dist|build|out|\.next|coverage|__pycache__|\.pio|\.vscode|\.build|target|\.venv)$/;

// ── webview: is it actually up, and reachable from another machine? ────

export interface PortResult {
  port: number;
  loopback: boolean;
  lan: boolean;
  status?: number;
}

export interface WebviewProbe {
  applies: boolean;
  /** True when a UI file changed but no listening port could be found at all. */
  staticOnly: boolean;
  lanIp: string | null;
  ports: PortResult[];
  note: string;
}

const PORT_PATTERNS: RegExp[] = [
  /\.listen\(\s*(\d{2,5})/g,
  /\blisten\(\s*(?:port\s*[:=]\s*)?(\d{2,5})/g,
  /\bPORT\s*[?:|]{0,2}=?\s*['"`]?(\d{2,5})/g,
  /\bport\s*[:=]\s*['"`]?(\d{2,5})/g,
  /--port[= ](\d{2,5})/g,
  /localhost:(\d{2,5})/g,
  /127\.0\.0\.1:(\d{2,5})/g,
  /0\.0\.0\.0:(\d{2,5})/g,
];

/**
 * Ports this probe must never touch.
 *
 * The infrastructure ayin talks to is reached through its own client, never poked by a scanner: the
 * model gateway in particular is behind the resource layer on purpose, and a probe GET is exactly
 * the kind of "harmless" side door that turns into a habit. Derived from the configured backend URL
 * at runtime plus `AYIN_QA_PORT_DENY` — never written down as a literal.
 */
function deniedPorts(): Set<number> {
  const set = new Set<number>();
  try {
    const p = Number(new URL(llmBaseUrl()).port);
    if (p > 0) set.add(p);
  } catch { /* unparseable config — nothing to exclude */ }
  for (const raw of (process.env.AYIN_QA_PORT_DENY || '').split(',')) {
    const p = Number(raw.trim());
    if (p > 0 && p < 65536) set.add(p);
  }
  return set;
}

/** Ports mentioned in the changed sources, plus an explicit override. Deduped, capped. */
export function detectPorts(files: ChangedFile[]): number[] {
  const found = new Set<number>();
  const override = Number(process.env.AYIN_QA_PORT || 0);
  if (override > 0 && override < 65536) found.add(override);
  for (const f of files) {
    if (!f.exists || f.bytes > 512 * 1024) continue;
    let text = '';
    try { text = readFileSync(f.path, 'utf-8'); } catch { continue; }
    for (const re of PORT_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const p = Number(m[1]);
        // Below 1024 is almost always a version number or a timeout, not a dev server.
        if (p >= 1024 && p <= 65535) found.add(p);
      }
    }
  }
  const deny = deniedPorts();
  return [...found].filter((p) => !deny.has(p)).slice(0, 6);
}

/**
 * This machine's LAN IPv4 — discovered at runtime, never written down.
 *
 * Virtual interfaces are skipped deliberately. `docker0` and friends are "non-internal" as far as
 * node is concerned, so taking the first match can hand you a bridge address: the probe would then
 * report a page as LAN-reachable when it answered on a bridge no other device can route to. A wrong
 * green light is worse than none.
 */
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|tun|tap|lo|utun|zt|tailscale|wg)/i;

export function lanAddress(): string | null {
  const ifaces = Object.entries(networkInterfaces());
  const real = ifaces.filter(([name]) => !VIRTUAL_IFACE.test(name));
  for (const [, list] of real) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/**
 * One probe GET. `agent: false` is load-bearing, not tidiness.
 *
 * Node's global agent keeps sockets alive and pools them per host:port. The QA gate probes the same
 * port on pass 1, the fix pass restarts the server, and pass 2 then reuses a pooled socket that the
 * NEW process resets — `ECONNRESET`, which reads as "nothing is listening". The gate would report a
 * running server as down and send the agent chasing a server it already fixed. Measured: with the
 * shared agent, a loopback server on a recently-reused port answers `ECONNRESET`; with a fresh socket
 * it answers 200. So: never pool, and close the connection when done.
 */
function httpHead(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | null) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = httpRequest({ host, port, path: '/', method: 'GET', timeout: timeoutMs, agent: false, headers: { connection: 'close' } }, (res) => {
        res.resume(); // drain — we only want the status line
        done(res.statusCode ?? 0);
      });
      req.on('timeout', () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
      req.end();
    } catch {
      done(null);
    }
  });
}

/**
 * Is there a webview here, is it up, and can another machine on the LAN reach it?
 *
 * "Reachable on the local network" is the criterion the operator actually cares about — a dev
 * server bound to loopback looks perfect on the machine that built it and is invisible from the
 * phone in your hand. The probe therefore checks BOTH addresses and reports the difference.
 */
export async function probeWebview(files: ChangedFile[], timeoutMs = 1500): Promise<WebviewProbe> {
  const uiFiles = files.filter((f) => f.kind === 'ui');
  const ports = detectPorts(files);
  const forced = !!process.env.AYIN_QA_PORT;
  const applies = forced || uiFiles.length > 0 || ports.length > 0;
  if (!applies) return { applies: false, staticOnly: false, lanIp: null, ports: [], note: 'no UI or server change in this turn' };

  const lanIp = lanAddress();
  const results: PortResult[] = [];
  for (const port of ports) {
    const [lo, lan] = await Promise.all([
      httpHead('127.0.0.1', port, timeoutMs),
      lanIp ? httpHead(lanIp, port, timeoutMs) : Promise.resolve(null),
    ]);
    if (lo === null && lan === null) continue; // nothing on that port — probably a false-positive match
    results.push({ port, loopback: lo !== null, lan: lan !== null, status: lo ?? lan ?? undefined });
  }

  const staticOnly = uiFiles.length > 0 && results.length === 0;
  const note = results.length === 0
    ? (staticOnly
      ? `UI file(s) changed (${uiFiles.map((f) => basename(f.path)).join(', ')}) and NO local HTTP server answered on any detected port (${ports.join(', ') || 'none detected'}) — if this is a webview it is not running`
      : `no HTTP server answered on the detected port(s): ${ports.join(', ') || 'none detected'}`)
    : results.map((r) => {
      if (r.loopback && r.lan) return `:${r.port} up and reachable from the LAN (${r.status})`;
      if (r.loopback && !r.lan) return `:${r.port} up but LOOPBACK-ONLY — not reachable from another machine (bind to 0.0.0.0)`;
      return `:${r.port} answered on the LAN address only (${r.status})`;
    }).join('; ');

  return { applies, staticOnly, lanIp, ports: results, note };
}

// ── README: present, and does it still describe the code? ─────────────

export interface ReadmeProbe {
  root: string;
  path: string | null;
  exists: boolean;
  bytes: number;
  headings: number;
  /** README older than the newest changed code file — it describes a previous version. */
  staleVsCode: boolean;
  note: string;
}

export function probeReadme(files: ChangedFile[], cwd = process.cwd()): ReadmeProbe {
  const root = projectRoot(cwd);
  const candidates = ['README.md', 'Readme.md', 'readme.md', 'README.MD'];
  const hit = candidates.map((c) => join(root, c)).find((p) => existsSync(p)) ?? null;
  const newestCode = files.filter((f) => f.exists && (f.kind === 'code' || f.kind === 'ui')).reduce((a, f) => Math.max(a, f.mtimeMs), 0);

  if (!hit) {
    return {
      root, path: null, exists: false, bytes: 0, headings: 0, staleVsCode: false,
      note: `no README.md at the project root (${root}) — a project with none needs one created`,
    };
  }
  let text = '';
  try { text = readFileSync(hit, 'utf-8'); } catch { /* unreadable */ }
  const st = (() => { try { return statSync(hit); } catch { return null; } })();
  const headings = (text.match(/^#{1,6} /gm) ?? []).length;
  const staleVsCode = !!st && newestCode > 0 && st.mtimeMs < newestCode;
  return {
    root, path: hit, exists: true, bytes: text.length, headings, staleVsCode,
    note: staleVsCode
      ? `README.md exists (${text.length} bytes, ${headings} headings) but was NOT touched in this change while code was — check it still describes reality`
      : `README.md exists (${text.length} bytes, ${headings} headings) and is at least as new as the changed code`,
  };
}

// ── markdown: is the format's range actually used? ─────────────────────

export interface MdProbe {
  path: string;
  headings: number;
  tables: number;
  fences: number;
  fencesWithLang: number;
  bullets: number;
  links: number;
  longestParagraph: number;
  note: string;
}

export function probeMarkdown(file: ChangedFile): MdProbe | null {
  if (!file.exists || file.kind !== 'doc') return null;
  let text = '';
  try { text = readFileSync(file.path, 'utf-8'); } catch { return null; }
  const headings = (text.match(/^#{1,6} /gm) ?? []).length;
  const tables = (text.match(/^\|.*\|\s*$/gm) ?? []).length;
  const fenceOpens = text.match(/^```[^\n]*$/gm) ?? [];
  const fences = Math.floor(fenceOpens.length / 2);
  const fencesWithLang = fenceOpens.filter((f) => f.trim().length > 3).length;
  const bullets = (text.match(/^\s*[-*+] /gm) ?? []).length;
  const links = (text.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  const longestParagraph = text.split(/\n\s*\n/).reduce((a, p) => Math.max(a, p.replace(/\s+/g, ' ').trim().length), 0);
  const bits = [`${headings} headings`, `${tables} table rows`, `${fences} code fences (${fencesWithLang} tagged)`, `${bullets} bullets`, `${links} links`, `longest paragraph ${longestParagraph} chars`];
  return { path: file.path, headings, tables, fences, fencesWithLang, bullets, links, longestParagraph, note: `${basename(file.path)}: ${bits.join(', ')}` };
}

// ── code shape: the structural signals behind "one responsibility" ────

export interface SrpProbe {
  path: string;
  lines: number;
  exports: number;
  classes: number;
  functions: number;
  /** Distinct concern families the file touches (fs, net, ui, db, …) — many is the smell. */
  concerns: string[];
  todos: number;
  note: string;
}

const CONCERNS: Array<[string, RegExp]> = [
  ['filesystem', /\b(readFileSync|writeFileSync|createReadStream|mkdirSync|unlinkSync|fs\.)/],
  ['network', /\b(fetch\(|httpRequest|axios|request\(|WebSocket|io\(|undici)/],
  ['process', /\b(spawn|execSync|execFile|child_process)/],
  ['ui', /\b(blessed|render\(|setBottom|screen\.|document\.|useState|StatelessWidget|StatefulWidget)/],
  ['database', /\b(sqlite|SELECT |INSERT INTO|prepare\(|db\.)/],
  ['llm', /\b(llmChat|llmCall|prompt|completion|embedding)/],
  ['parsing', /\b(JSON\.parse|RegExp\(|\.match\(|parse[A-Z])/],
  ['scheduling', /\b(setInterval|setTimeout|cron|schedule)/],
];

export function probeSrp(file: ChangedFile): SrpProbe | null {
  if (!file.exists || (file.kind !== 'code' && file.kind !== 'ui')) return null;
  if (file.bytes > 512 * 1024) return null;
  let text = '';
  try { text = readFileSync(file.path, 'utf-8'); } catch { return null; }
  const lines = text.split('\n').length;
  const exports = (text.match(/^export /gm) ?? []).length;
  const classes = (text.match(/^\s*(export\s+)?(abstract\s+)?class\s+\w/gm) ?? []).length;
  const functions = (text.match(/^\s*(export\s+)?(async\s+)?function\s+\w/gm) ?? []).length
    + (text.match(/^\s*(export\s+)?const\s+\w+\s*(:[^=]+)?=\s*(async\s*)?\(/gm) ?? []).length;
  const concerns = CONCERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  const todos = (text.match(/\b(TODO|FIXME|XXX|placeholder|lorem ipsum|not implemented)\b/gi) ?? []).length;
  return {
    path: file.path, lines, exports, classes, functions, concerns, todos,
    note: `${basename(file.path)}: ${lines} lines, ${exports} exports, ${classes} classes, ${functions} functions, concerns [${concerns.join(', ') || 'none detected'}]${todos ? `, ${todos} TODO/placeholder marker(s)` : ''}`,
  };
}

// ── third-party APIs: the one thing a model must not answer from memory ─

export interface ApiProbe {
  applies: boolean;
  /** External hosts the changed code talks to. */
  hosts: string[];
  /** Credential-shaped env vars it reads — a strong signal of a real integration. */
  keys: string[];
  /** Auth/versioning shapes found, which is what goes stale first. */
  signals: string[];
  note: string;
}

/** Hosts that are this machine, not a third party. */
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|.*\.local)$/i;

/**
 * Does this change integrate somebody else's API?
 *
 * Detected from the code, not from a model's opinion: external hosts in URLs, credential-shaped env
 * vars, and the auth/versioning shapes (`Bearer`, `/v1/`, OAuth) that go out of date first. This is the
 * one category where a model's recalled knowledge is actively dangerous — an API it "knows" may have
 * changed its auth scheme, renamed a field or deprecated the endpoint since training, and the code will
 * look perfectly reasonable while failing against the live service.
 */
export function probeThirdPartyApi(files: ChangedFile[]): ApiProbe {
  const hosts = new Set<string>();
  const keys = new Set<string>();
  const signals = new Set<string>();

  for (const f of files) {
    if (!f.exists || f.bytes > 512 * 1024) continue;
    let text = '';
    try { text = readFileSync(f.path, 'utf-8'); } catch { continue; }

    for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
      const host = m[1];
      if (!LOCAL_HOST.test(host) && host.includes('.')) hosts.add(host);
    }
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})(?:_API_KEY|_TOKEN|_SECRET|_CLIENT_ID|_CLIENT_SECRET|_APP_KEY)\b/g)) {
      keys.add(m[0]);
    }
    if (/Authorization['"\s:]+.{0,20}Bearer/i.test(text)) signals.add('bearer-token auth');
    if (/\boauth2?\b/i.test(text)) signals.add('OAuth flow');
    if (/\/v[123]\//.test(text)) signals.add('versioned endpoint path');
    if (/\bx-api-key\b/i.test(text)) signals.add('x-api-key header');
    if (/\b(rate.?limit|429)\b/i.test(text)) signals.add('rate-limit handling present');
  }

  const applies = hosts.size > 0 || keys.size > 0;
  const note = applies
    ? `third-party integration detected — hosts: ${[...hosts].slice(0, 6).join(', ') || 'none'}`
      + `${keys.size ? `; credentials: ${[...keys].slice(0, 6).join(', ')}` : ''}`
      + `${signals.size ? `; shapes: ${[...signals].join(', ')}` : ''}`
      + `${signals.has('rate-limit handling present') ? '' : '; NO rate-limit/429 handling found'}`
    : 'no external API in this change';
  return { applies, hosts: [...hosts], keys: [...keys], signals: [...signals], note };
}

// ── Arduino: a hard toolchain rule, not a style opinion ─────────────────

export interface ArduinoSketch {
  path: string;
  /** What the toolchain REQUIRES this file to be named — its containing folder's name + .ino/.pde. */
  expectedName: string;
  matches: boolean;
}

export interface ArduinoProbe {
  applies: boolean;
  sketches: ArduinoSketch[];
  /** True when the changed code actually touches physical pins — not every Arduino edit is wiring. */
  wiringLikely: boolean;
  note: string;
}

/** Real hardware I/O calls — the unambiguous signal that a PIN, not just code, is involved. */
const PIN_IO_RE = /\b(pinMode|digitalWrite|digitalRead|analogWrite|analogRead|attachInterrupt)\s*\(/;
/** Softer signal: prose that talks about wiring even without a matching I/O call this turn (e.g. a
 *  comment-only change, or a header that only declares pins another file uses). */
const WIRING_WORD_RE = /\b(wiring|breadboard|schematic|circuit diagram|pinout)\b/i;

/**
 * Is this an Arduino project, and — the concrete complaint this probe exists for — does each changed
 * `.ino`/`.pde` sketch have the name the Arduino toolchain (IDE and arduino-cli both) REQUIRES: exactly
 * its containing folder's name. `Blinker/Blinker.ino` is correct and `Blinker/main.ino` will not even
 * compile. A reviewer that does not know this rule reads a renamed-to-match-the-folder file as a naming
 * oddity and flags it — the false positive reported. This probe turns "the reviewer's opinion" into "a
 * measured fact," so the criterion built on it can say `matches: true` is correct, not merely unusual.
 */
export function probeArduinoProject(files: ChangedFile[], cwd = process.cwd()): ArduinoProbe {
  const root = projectRoot(cwd);
  const sketchFiles = files.filter((f) => /\.(ino|pde)$/i.test(f.path));
  const projectMarker = existsSync(join(root, 'platformio.ini')) || existsSync(join(root, 'sketch.yaml'));
  const applies = sketchFiles.length > 0 || projectMarker;

  const sketches: ArduinoSketch[] = sketchFiles.map((f) => {
    const folder = basename(dirname(f.path));
    const ext = extname(f.path);
    const expectedName = `${folder}${ext}`;
    return { path: f.path, expectedName, matches: basename(f.path) === expectedName };
  });

  let wiringLikely = false;
  for (const f of files) {
    if (!f.exists || f.bytes > 512 * 1024) continue;
    if (!/\.(ino|pde|h|hpp|cpp|c)$/i.test(f.path)) continue;
    let text = '';
    try { text = readFileSync(f.path, 'utf-8'); } catch { continue; }
    if (PIN_IO_RE.test(text) || WIRING_WORD_RE.test(text)) { wiringLikely = true; break; }
  }

  const mismatches = sketches.filter((s) => !s.matches);
  const note = !applies
    ? 'not an Arduino project'
    : [
      sketches.length > 0
        ? mismatches.length > 0
          ? `SKETCH NAMING VIOLATED: ${mismatches.map((m) => `${basename(m.path)} must be renamed to ${m.expectedName} (its folder's name) — the Arduino toolchain requires this, it will not build otherwise`).join('; ')}`
          : `sketch filename(s) correctly match their folder (required by the toolchain, NOT a style choice — do not flag this as unusual): ${sketches.map((s) => basename(s.path)).join(', ')}`
        : 'Arduino project (platformio.ini/sketch.yaml present), no .ino changed this turn',
      wiringLikely ? 'this change touches physical pins (pinMode/digitalWrite/analogRead/…) or discusses wiring' : '',
    ].filter(Boolean).join('; ');

  return { applies, sketches, wiringLikely, note };
}

// ── the evidence block handed to the judge ─────────────────────────────

export interface Evidence {
  files: ChangedFile[];
  webview: WebviewProbe;
  readme: ReadmeProbe;
  markdown: MdProbe[];
  srp: SrpProbe[];
  api: ApiProbe;
  arduino: ArduinoProbe;
  /**
   * Facts contributed by the project-type QA executor — a real compile result, a real PlantUML parse,
   * a real deliverable check. Kept as an opaque list rather than typed per project type so this
   * module stays what it is: the generic probe layer. The executor owns the meaning; this owns the
   * rendering. (Typed as a structural shape, not imported from `executors/types`, to keep the
   * dependency pointing one way — executors know about probes, probes do not know about executors.)
   */
  executorFacts: Array<{ key: string; ok: boolean; detail: string }>;
}

export async function gatherEvidence(
  files: ChangedFile[],
  executorFacts: Array<{ key: string; ok: boolean; detail: string }> = [],
): Promise<Evidence> {
  return {
    files,
    webview: await probeWebview(files),
    readme: probeReadme(files),
    markdown: files.map(probeMarkdown).filter((m): m is MdProbe => !!m),
    srp: files.map(probeSrp).filter((s): s is SrpProbe => !!s),
    api: probeThirdPartyApi(files),
    arduino: probeArduinoProject(files),
    executorFacts,
  };
}

/** The evidence as plain text for the judge prompt — facts only, no opinions. */
export function renderEvidence(e: Evidence): string {
  const out: string[] = [];
  out.push('CHANGED FILES:');
  for (const f of e.files) {
    out.push(`  ${f.path} [${f.kind}] ${f.exists ? `${f.bytes} bytes, ${f.lines} lines` : 'MISSING (deleted?)'}`);
  }
  out.push(`\nWEBVIEW REACHABILITY: ${e.webview.applies ? e.webview.note : 'not applicable'}`);
  if (e.webview.applies && e.webview.lanIp) out.push(`  (probed loopback and this machine's LAN address)`);
  out.push(`\nTHIRD-PARTY API: ${e.api.note}`);
  if (e.arduino.applies) out.push(`\nARDUINO PROJECT: ${e.arduino.note}`);
  out.push(`\nREADME: ${e.readme.note}`);
  if (e.srp.length) {
    out.push('\nCODE SHAPE (structural signals — many unrelated concerns in one file is the smell):');
    for (const s of e.srp) out.push(`  ${s.note}`);
  }
  if (e.markdown.length) {
    out.push('\nMARKDOWN RICHNESS:');
    for (const m of e.markdown) out.push(`  ${m.note}`);
  }
  if (e.executorFacts.length) {
    // Last and clearly separated, because these are the STRONGEST facts in the block — a compiler's
    // own verdict and a renderer's own parse, not a heuristic. The prefix makes each one's polarity
    // unmissable so a judge skimming cannot read a failure as a pass.
    out.push('\nPROJECT-TYPE CHECKS (run by the real toolchain — these outrank any reading of the code):');
    for (const f of e.executorFacts) {
      const head = `  [${f.ok ? 'OK  ' : 'FAIL'}] ${f.key}: `;
      out.push(`${head}${f.detail.split('\n').join(`\n${' '.repeat(10)}`)}`);
    }
  }
  return out.join('\n');
}
