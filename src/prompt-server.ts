/**
 * The session's local HTTP surface. Two things live here:
 *
 *   /                  the prompt editor — reads/writes the prompt files, live on the next LLM call
 *   /diff, /api/diff/  the review page and its line comments (see diff/server.ts)
 *
 * IT LISTENS ON THE LAN. The page is read from a phone as often as from this machine, and a page you
 * cannot reach is a page you do not use — so the bind is `0.0.0.0` and the served URL is printed twice,
 * loopback and network. That is an ACCEPTED EXPOSURE, not an oversight: everything behind this port is
 * reachable by anything on the same network, including `POST /api/prompts` (which rewrites the agent's
 * own system prompt) and the comment routes (which start headless runs with an unsandboxed `bash`).
 * Serve it on a network you trust. The Host allowlist below is still enforced — it is what stops a
 * hostile DNS name from resolving to this box and POSTing through the browser of someone on it.
 *
 * ONE PORT PER SESSION, NOT ONE PER MACHINE. 7773 was a constant, so the second ayin on the box lost
 * the bind, logged a warning, and ran with no server at all — and once the review page became a client
 * of this server, that stopped being cosmetic: a page served by one session while another session owns
 * the repo would send the operator's comments to an agent sitting in a different tree. So the bind
 * walks up from 7773 until it finds a free port, and every session publishes what it took to
 * `~/.ayin-cli/daemon-<pid>.json`. The page is served over the port it was opened from, and its own
 * relative fetches come back to that same session — there is nothing to route and nothing to guess.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { log } from './log.js';
import { resetPromptsToDefaults, getPromptsDir as promptsDir } from './prompts.js';
import { prompts, writeAtomic } from './prompts-service.js';
import { handleDiffRequest } from './diff/server.js';
import { handleSprintRequest } from './sprint/server.js';
import { agentActivity } from './agent-activity.js';

const BASE_PORT = 7773;
const PORT_TRIES = 12;

let chosenPort = 0;

/** The port this session actually got, or 0 before the bind succeeds / in a process with no server. */
export function serverPort(): number {
  return chosenPort;
}

export function serverUrl(path = ''): string {
  return chosenPort ? `http://127.0.0.1:${chosenPort}${path}` : '';
}

/**
 * THE ADDRESS A PHONE CAN REACH — one of them, chosen, not all of them listed.
 *
 * A laptop has several: Wi-Fi, ethernet, a VPN's `utun`, docker's bridge, and `networkInterfaces()`
 * returns them in an order that is the OS's business rather than a preference. Printing all of them
 * makes the operator guess; printing the first one hands them a VPN address that nothing on the sofa
 * can route. So the RFC1918 ranges are preferred in the order a home or office network actually uses
 * them, and anything else is the last resort.
 *
 * Returns null when there is no non-loopback IPv4 at all — a machine with the network off. The caller
 * prints only the loopback line then, rather than a URL that resolves to nothing.
 */
export function lanAddress(): string | null {
  const rank = (a: string): number => {
    if (a.startsWith('192.168.')) return 0;
    if (a.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 2;
    if (a.startsWith('169.254.')) return 4;   // link-local: an interface with no DHCP answer
    return 3;
  };
  const found: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      // `family` is the string 'IPv4' on Node 18+ and the number 4 on older builds — accept both rather
      // than silently finding nothing on one of them.
      if ((a.family === 'IPv4' || (a.family as unknown as number) === 4) && !a.internal) found.push(a.address);
    }
  }
  if (!found.length) return null;
  return found.sort((x, y) => rank(x) - rank(y) || x.localeCompare(y))[0];
}

/** The same page over the network, for a phone. Empty when nothing is bound or there is no LAN address. */
export function serverLanUrl(path = ''): string {
  const ip = lanAddress();
  return chosenPort && ip ? `http://${ip}:${chosenPort}${path}` : '';
}

/**
 * Every literal host this server answers as. IP ADDRESSES AND `localhost`, never an arbitrary name —
 * see crossOriginRefused: this list is the DNS-rebinding defence, and a wildcard here removes it.
 */
function servedHosts(): string[] {
  const hosts = ['127.0.0.1', 'localhost', '[::1]', '::1'];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if ((a.family === 'IPv4' || (a.family as unknown as number) === 4) && !a.internal) hosts.push(a.address);
    }
  }
  return hosts;
}

// ── who is listening, and for which tree ──────────────────────────────────────

export interface DaemonRecord {
  pid: number;
  port: number;
  cwd: string;
  startedAt: string;
}

function registryPath(pid: number): string {
  return join(homedir(), '.ayin-cli', `daemon-${pid}.json`);
}

function publish(rec: DaemonRecord): void {
  try {
    mkdirSync(join(homedir(), '.ayin-cli'), { recursive: true });
    writeFileSync(registryPath(rec.pid), `${JSON.stringify(rec, null, 2)}\n`, 'utf-8');
  } catch (e) {
    log('WARN', 'daemon_publish_failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

function unpublish(pid: number): void {
  try { rmSync(registryPath(pid), { force: true }); } catch { /* going away anyway */ }
}

/**
 * A live session serving `cwd`, if there is one. Used by `ayin diff` from a plain shell: when the
 * operator has a TUI open on this repo, the CLI hands them that session's interactive page instead of
 * writing a second, dead copy to disk.
 *
 * A record whose process is gone is DELETED here rather than returned. Stale entries are normal — a
 * session killed with SIGKILL never runs its exit hook — and a caller that trusted one would open a
 * URL that refuses the connection.
 */
export function findSessionServer(cwd: string): DaemonRecord | null {
  const dir = join(homedir(), '.ayin-cli');
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!/^daemon-\d+\.json$/.test(name)) continue;
    const p = join(dir, name);
    let rec: DaemonRecord;
    try { rec = JSON.parse(readFileSync(p, 'utf-8')) as DaemonRecord; } catch { continue; }
    let alive = false;
    try { process.kill(rec.pid, 0); alive = true; } catch { alive = false; }
    if (!alive) { try { rmSync(p, { force: true }); } catch { /* raced another reader */ } continue; }
    if (rec.cwd === cwd && rec.port > 0) return rec;
  }
  return null;
}

/**
 * Prompt TEXT lives in `~/.ayin-cli/prompts/<namespace>/<id>.txt` (see prompts-service.ts), not in
 * prompts.json. The editor still speaks one JSON document, so we project the file store into that
 * shape — keys are `<namespace>/<id>` so a tool's prompts are editable here too — and fan a save
 * back out to the individual files. The files stay the source of truth; this is just a view.
 */
function readPrompts(): string {
  const doc: Record<string, { description: string; content: string }> = {};
  for (const ns of prompts.list()) {
    for (const id of ns.ids) {
      doc[`${ns.namespace}/${id}`] = {
        description: `${ns.namespace} · ${id}`,
        content: prompts.bundle(ns.namespace).get(id),
      };
    }
  }
  return JSON.stringify(doc, null, 2);
}

/** Fan a saved document back out to the individual prompt files. Returns ids written. */
function writePrompts(body: string): string[] {
  const doc = JSON.parse(body) as Record<string, { content?: unknown }>;
  const written: string[] = [];
  for (const [key, val] of Object.entries(doc)) {
    const slash = key.indexOf('/');
    if (slash < 1) continue; // not a namespaced prompt key — ignore
    const ns = key.slice(0, slash);
    const id = key.slice(slash + 1);
    // The namespace was validated (it must already exist); the id never was, so a `../`-bearing key
    // escaped the prompts directory and wrote an arbitrary `.txt` wherever the process could reach.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    const content = val?.content;
    if (typeof content !== 'string') continue;
    const dir = join(promptsDir(), ns);
    if (!existsSync(dir)) continue; // never invent a namespace from the browser
    writeAtomic(join(dir, `${id}.txt`), content.endsWith('\n') ? content : content + '\n');
    written.push(key);
  }
  return written;
}

const HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Ayin Prompts</title>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    h1 { color: #7B8CDE; margin-bottom: 20px; font-size: 1.4em; }
    .prompt { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .prompt-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .prompt-key { color: #7B8CDE; font-weight: bold; font-size: 1.1em; }
    .prompt-desc { color: #8b949e; font-size: 0.85em; margin-bottom: 8px; }
    .config-grid { display: grid; grid-template-columns: 1fr 100px; gap: 8px; align-items: center; }
    .config-label { color: #c9d1d9; font-size: 0.9em; }
    .config-input {
      background: #0d1117; color: #c9d1d9; border: 1px solid #30363d;
      border-radius: 4px; padding: 6px 10px; font-size: 14px; text-align: right;
      font-family: 'JetBrains Mono', monospace;
    }
    .config-input:focus { outline: none; border-color: #7B8CDE; }
    textarea {
      width: 100%; min-height: 200px; background: #0d1117; color: #c9d1d9;
      border: 1px solid #30363d; border-radius: 4px; padding: 10px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px;
      resize: vertical; line-height: 1.5;
    }
    textarea:focus { outline: none; border-color: #7B8CDE; }
    .actions { margin-top: 20px; display: flex; gap: 10px; align-items: center; }
    button {
      background: #7B8CDE; color: #0d1117; border: none; padding: 8px 20px;
      border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 14px;
    }
    button:hover { background: #A0ADEE; }
    .status { color: #8b949e; font-size: 0.85em; }
    .status.saved { color: #3fb950; }
    .status.error { color: #f85149; }
    .vars { color: #8b949e; font-size: 0.8em; margin-top: 4px; }
    .vars code { color: #e5c07b; background: #1c2128; padding: 1px 4px; border-radius: 2px; }
  </style>
</head>
<body>
  <h1>⬡ Ayin Prompt Editor</h1>
  <div id="prompts"></div>
  <div class="actions">
    <button onclick="save()">Save All</button>
    <span id="status" class="status"></span>
  </div>
  <script>
    let data = {};

    async function load() {
      const res = await fetch('/api/prompts');
      data = await res.json();
      render();
    }

    const CONFIG_LABELS = {
      windowSize: 'Context window (messages kept in LLM context)',
      maxToolRounds: 'Max tool rounds per user prompt',
      summaryMaxWords: 'Summary max words',
      summaryRecentMessages: 'Recent messages kept in summary',
    };

    function render() {
      const container = document.getElementById('prompts');
      container.innerHTML = '';

      // Config section
      if (data.config) {
        let configHtml = '<div class="prompt"><div class="prompt-header"><span class="prompt-key">config</span></div>';
        configHtml += '<div class="prompt-desc">Agent behavior settings (changes take effect immediately)</div>';
        configHtml += '<div class="config-grid">';
        for (const [k, v] of Object.entries(data.config)) {
          const label = CONFIG_LABELS[k] || k;
          configHtml += \`<div class="config-label">\${label}</div>\`;
          configHtml += \`<input type="number" class="config-input" value="\${v}" onchange="updateConfig('\${k}', this.value)">\`;
        }
        configHtml += '</div></div>';
        container.innerHTML += configHtml;
      }

      // Prompt sections
      for (const [key, entry] of Object.entries(data)) {
        if (key === 'config') continue;
        const vars = (entry.content.match(/\\{\\{\\w+\\}\\}/g) || []).map(v => '<code>' + v + '</code>').join(', ');
        container.innerHTML += \`
          <div class="prompt">
            <div class="prompt-header">
              <span class="prompt-key">\${key}</span>
            </div>
            <div class="prompt-desc">\${entry.description || ''}</div>
            \${vars ? '<div class="vars">Variables: ' + vars + '</div>' : ''}
            <textarea id="prompt-\${key}" oninput="updatePrompt('\${key}', this.value)">\${entry.content}</textarea>
          </div>
        \`;
      }
    }

    function updatePrompt(key, value) {
      if (data[key]) data[key].content = value;
    }

    function updateConfig(key, value) {
      if (data.config) data.config[key] = parseInt(value, 10);
    }

    async function save() {
      const status = document.getElementById('status');
      try {
        const res = await fetch('/api/prompts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (res.ok) {
          status.textContent = 'Saved ✓';
          status.className = 'status saved';
        } else {
          status.textContent = 'Save failed';
          status.className = 'status error';
        }
      } catch (e) {
        status.textContent = 'Error: ' + e.message;
        status.className = 'status error';
      }
      setTimeout(() => { status.textContent = ''; }, 3000);
    }

    load();
  </script>
</body>
</html>`;

/**
 * A page on the internet can make your browser POST to this port; it cannot read the reply, but it does
 * not need to when the POST itself is the effect — and here the effect is an agent turn with a shell.
 * So a request that carries an Origin must carry OURS, and the Host must be an ADDRESS THIS BOX HOLDS:
 * a name that resolves to it is how DNS rebinding gets past an address check, and the LAN bind did not
 * make that attack cheaper, it made it worth checking for on more than one address. A request with no
 * Origin at all is a tool — curl, a script — and is allowed: that is an operator, not a web page.
 *
 * The phone is why the allowlist is computed rather than constant. It asks for this box by its LAN
 * address and its POSTs carry that as their Origin, so a loopback-only list refused every comment
 * written on one.
 */
function crossOriginRefused(req: IncomingMessage): string | null {
  const hosts = servedHosts();
  const host = (req.headers.host ?? '').split(':')[0];
  if (host && !hosts.includes(host)) {
    return `Host ${host} is not an address of this machine`;
  }
  const origin = req.headers.origin;
  if (!origin) return null;
  const allowed = hosts.map((h) => `http://${h}:${chosenPort}`);
  return allowed.includes(origin) ? null : `Origin ${origin} is not this session`;
}

/**
 * Told when the socket is up, or when it could not be. The TUI ignores both — it starts the server and
 * carries on — but a plain-shell `ayin diff` / `ayin sprint` has nothing else to do until there is a
 * port to open, and must SAY SO rather than hang when twelve ports in a row are taken.
 */
export type ServerReady = (r: { port: number } | { error: string }) => void;

export function startPromptServer(cwd = process.cwd(), onReady?: ServerReady): void {
  const server = createServer((req, res) => {
    // Every mutating route is behind this, including the prompt editor's own save — it rewrites the
    // agent's system prompt, which was reachable by any page in the browser until now.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const refused = crossOriginRefused(req);
      if (refused) {
        log('WARN', 'server_request_refused', { reason: refused, url: req.url ?? '' });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: refused }));
        return;
      }
    }

    // What the agent is doing, for any page that wants to show progress rather than a spinner. Cheap
    // enough to poll every second: one object, no work, no I/O.
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/api/agent/state') {
      const a = agentActivity();
      const body = JSON.stringify({ ...a, elapsedMs: Date.now() - a.since });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    // The review page and its comments, then the sprint board. Each returns true when it answered.
    void handleDiffRequest(req, res, cwd).then(async (handled) => {
      if (handled) return;
      if (await handleSprintRequest(req, res)) return;
      routePromptEditor(req, res);
    }).catch((e) => {
      log('WARN', 'diff_route_failed', { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) { res.writeHead(500); res.end('diff route failed'); }
    });
  });

  bind(server, cwd, BASE_PORT, PORT_TRIES, onReady);
}

function routePromptEditor(req: IncomingMessage, res: ServerResponse): void {
  {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML);
      return;
    }

    if (req.url === '/api/prompts' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(readPrompts());
      return;
    }

    if (req.url === '/api/prompts' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const written = writePrompts(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
          log('INFO', 'prompts_saved', { ids: written.join(','), count: String(written.length) });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(`{"error":"${e instanceof Error ? e.message : 'invalid json'}"}`);
        }
      });
      return;
    }

    if (req.url === '/api/reset' && req.method === 'POST') {
      try {
        resetPromptsToDefaults();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"message":"Prompts restored to defaults"}');
        log('INFO', 'api_reset', {});
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }
}

/**
 * THE LAN, DELIBERATELY. This was `127.0.0.1`, and that was the right default for a prompt editor
 * nobody read off a phone. The review page is: a diff is read on a sofa, a sprint board is read on a
 * commute, and a page reachable only from the machine that serves it is a page opened on the machine
 * that has the editor open anyway.
 *
 * WHAT THIS COSTS, stated plainly rather than discovered later: there is no auth on this port. Anything
 * on the same network can `POST /api/prompts` — which rewrites the agent's own system prompt — and can
 * write a review comment, which spawns a headless ayin whose `bash` has no sandbox. The Origin and Host
 * checks above stop a WEB PAGE from driving it through your browser; they stop nothing that can talk to
 * the port directly. This is a trusted-network feature. On an untrusted one, do not run it.
 *
 * The port is not fixed (see the header): EADDRINUSE walks up, because a second session with no server
 * is a second session whose review page cannot take comments.
 */
function bind(
  server: import('node:http').Server,
  cwd: string,
  port = BASE_PORT,
  tries = PORT_TRIES,
  onReady?: ServerReady,
): void {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && tries > 1) {
      log('INFO', 'server_port_taken', { port: String(port) });
      bind(server, cwd, port + 1, tries - 1, onReady);
      return;
    }
    log('WARN', 'prompt_server_error', { error: err.message, port: String(port) });
    // A TUI survives this — it loses a page nobody asked for yet. A command whose whole job is to serve
    // one page has to end, and with the reason: silence here was a process sitting there doing nothing.
    onReady?.({ error: err.code === 'EADDRINUSE'
      ? `every port from ${BASE_PORT} to ${port} is taken — ${PORT_TRIES} tries`
      : err.message });
  });

  server.listen(port, '0.0.0.0', () => {
    chosenPort = port;
    publish({ pid: process.pid, port, cwd, startedAt: new Date().toISOString() });
    log('INFO', 'prompt_server_started', { port: String(port), cwd, lan: lanAddress() ?? 'none' });
    // The record is a claim that this port is live. It must not outlive the process that made it.
    const clean = () => unpublish(process.pid);
    process.on('exit', clean);
    process.on('SIGINT', clean);
    process.on('SIGTERM', clean);
    onReady?.({ port });
  });
}
