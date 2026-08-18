/**
 * Permissions — controls which tool calls the agent can make.
 *
 * Whitelist rules:
 *   - Exact match: "read_file" → all read_file calls allowed
 *   - Prefix match: "bash npm" → allows "npm install", "npm run build", etc.
 *   - Param match: "bash npm install" → allows only "npm install ..."
 *
 * Default whitelist: read_file, grep, find_files (read-only, safe)
 * Everything else requires permission dialog.
 *
 * Dialog options:
 *   - Allow once: this specific call only
 *   - Allow all <tool>: whitelist the tool name
 *   - Allow all <tool> <prefix>: whitelist tool + arg prefix
 *   - Deny: stop the agent loop
 */

import { showDialog, type DialogOption } from './dialog.js';
import { log } from './log.js';
import { HEADLESS } from './ui.js';

/**
 * Skip the confirmation prompts for this SESSION.
 *
 * Starts from `--dangerously-skip-permissions` and can be toggled at runtime with `/skip-permissions`
 * — the benchmark case: running the same prompt against several agents and wanting none of them to
 * stop on a dialog.
 *
 * DELIBERATELY NOT PERSISTED. `modes.ts` persists its toggles because a mode you must re-enable every
 * session is a mode you stop using; the opposite reasoning applies here. A permission gate that
 * silently stayed off after a restart is one nobody remembers turning off, and the first they learn
 * of it is the thing it would have stopped.
 *
 * It also does NOT reach the push/pull/checkout guard — that check runs first, above every rule here,
 * and under a skip flag it DENIES rather than allows. Those are unrecoverable and public; the only
 * safe answer with nobody watching is no.
 */
let skipPermissions = process.argv.includes('--dangerously-skip-permissions');

export function isSkippingPermissions(): boolean { return skipPermissions; }

/** Returns the new state. Session-scoped: nothing is written to disk. */
export function setSkipPermissions(on: boolean): boolean {
  skipPermissions = on;
  log(on ? 'WARN' : 'INFO', on ? 'permissions_skipped_on' : 'permissions_skipped_off', {});
  return skipPermissions;
}
// Read-only mode (env AYIN_READONLY=1): hard-deny anything outside the safe read whitelist,
// even in headless. For callers that must NUDGE, never edit (e.g. the premortem-hound doggo).
const READONLY = process.env.AYIN_READONLY === '1';

interface WhitelistEntry {
  tool: string;
  prefix?: string;  // optional param prefix (e.g. "npm install")
}

// Default safe tools — read-only, no side effects
const whitelist: WhitelistEntry[] = [
  { tool: 'read_file' },
  { tool: 'grep' },
  { tool: 'find_files' },
  { tool: 'web_search' },
];

/**
 * Operations that are confirmed EVERY time, whatever the whitelist says.
 *
 * Added after the agent pushed to a remote without being asked. Three separate holes let it:
 * `HEADLESS` auto-approved every tool call; "Allow all bash" whitelists the *whole tool* for the
 * session; and the prefix option offers `git` as a one-word prefix, so approving a single
 * `git status` silently approves every `git push` after it. Each is reasonable on its own and
 * together they mean one careless Enter authorises rewriting a remote.
 *
 * These are the operations whose blast radius leaves the machine or discards work that was never
 * committed — a push is public and cannot be un-published, a pull and a checkout can both destroy
 * uncommitted changes. They are never whitelisted, never prefix-matched, and never auto-approved.
 *
 * Over-triggering is deliberate: a needless confirmation costs one keystroke, a missed one cost the
 * incident this exists to prevent.
 */
const ALWAYS_CONFIRM_GIT = /(^|\s)(push|pull|checkout)(\s|$)/;

/** The dangerous git operation in this command, or null. Checks each shell segment separately so
 *  `git log | grep checkout` is not mistaken for a checkout. */
export function dangerousShellOp(command: string): string | null {
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    if (!/(^|\s)git(\s|$)/.test(segment)) continue;
    const m = segment.match(ALWAYS_CONFIRM_GIT);
    if (m) return `git ${m[2]}`;
  }
  return null;
}

export function isWhitelisted(tool: string, params: Record<string, string>): boolean {
  for (const entry of whitelist) {
    if (entry.tool !== tool) continue;
    if (!entry.prefix) return true; // tool-level whitelist
    // Check if the primary param starts with the prefix
    const primaryValue = getPrimaryParam(tool, params);
    if (primaryValue && primaryValue.startsWith(entry.prefix)) return true;
  }
  return false;
}

function getPrimaryParam(tool: string, params: Record<string, string>): string {
  // The "main" param for each tool, used for prefix matching
  switch (tool) {
    case 'bash': return params.command || '';
    case 'write_file': return params.path || '';
    case 'plan': return params.goal || '';
    case 'build': return params.plan_file || '';
    default: return Object.values(params)[0] || '';
  }
}

function addToWhitelist(tool: string, prefix?: string): void {
  // Don't duplicate
  const exists = whitelist.some(e =>
    e.tool === tool && e.prefix === prefix
  );
  if (!exists) {
    whitelist.push({ tool, prefix });
    log('INFO', 'permission_whitelist_add', { tool, prefix: prefix || '(all)' });
  }
}

export type PermissionResult = 'allow' | 'deny';

/**
 * Check permission for a tool call. Shows dialog if not whitelisted.
 * Returns 'allow' or 'deny'.
 */
export async function checkPermission(
  tool: string,
  params: Record<string, string>,
  reason?: string,
): Promise<PermissionResult> {
  const primaryValue = getPrimaryParam(tool, params);

  // FIRST, before every other rule — a whitelist, a skip flag or headless mode must not be able to
  // wave these through. This is the one check that no configuration can turn off.
  const danger = dangerousShellOp(primaryValue);
  if (danger) {
    // Nobody is watching a headless run, and there is no popup to show. The only safe answer to
    // "may I push?" with no human present is no.
    if (HEADLESS || skipPermissions || READONLY) {
      log('WARN', 'permission_dangerous_denied_unattended', { tool, op: danger, param: primaryValue.slice(0, 200) });
      return 'deny';
    }
    const choice = await showDialog(
      `Allow ${danger}?`,
      // Deliberately NO "allow all" and no prefix option: those are exactly what let one approval
      // authorise every later push. This asks every single time, by design.
      [{ label: 'Allow once', key: 'y' }, { label: 'Deny (stop agent)', key: 'n', danger: true }],
      {
        target: primaryValue,
        subtitle: 'always confirmed — this cannot be whitelisted',
        body: reason || undefined,
        footer: '↑↓ select · Enter confirm · Esc = deny',
      },
    );
    const allowed = choice === 0;
    log(allowed ? 'INFO' : 'WARN', allowed ? 'permission_dangerous_allowed' : 'permission_dangerous_denied',
      { tool, op: danger, param: primaryValue.slice(0, 200) });
    return allowed ? 'allow' : 'deny';
  }

  if (READONLY) {
    const ok = isWhitelisted(tool, params);
    log('INFO', ok ? 'permission_readonly_allow' : 'permission_readonly_deny', { tool });
    return ok ? 'allow' : 'deny';
  }
  if (skipPermissions || HEADLESS) {
    log('INFO', 'permission_skip', { tool });
    return 'allow';
  }
  if (isWhitelisted(tool, params)) return 'allow';

  // Build prefix options for "allow all starting with..."
  const prefixParts = primaryValue.split(/\s+/);
  const prefixOptions: string[] = [];
  if (prefixParts.length >= 2) {
    // e.g. "npm install express" → offer "npm install" and "npm"
    prefixOptions.push(prefixParts.slice(0, 2).join(' '));
    if (prefixParts.length >= 3) {
      prefixOptions.push(prefixParts.slice(0, 1).join(' '));
    }
  }

  const options: DialogOption[] = [
    { label: 'Allow once', key: 'y' },
    { label: `Allow all ${tool}`, key: 'a' },
  ];

  for (const prefix of prefixOptions) {
    options.push({ label: `Allow all ${tool} starting with "${prefix}"`, note: 'prefix' });
  }

  options.push({ label: 'Deny (stop agent)', key: 'n', danger: true });

  // Structured, not concatenated: the tool is the question, the path/command is the TARGET (shown in
  // full and wrapped — a truncated "/Users/…/clea…" tells you nothing about what you're approving),
  // and the agent's reason is the body. The dialog wraps each part and sizes itself to fit.
  const size = tool === 'write_file' && params.content !== undefined
    ? `${(params.content.length / 1024).toFixed(1)} KB`
    : '';
  const choice = await showDialog(
    `Allow ${tool}?`,
    options,
    {
      target: primaryValue || '(no argument)',
      subtitle: size ? `writing ${size}` : undefined,
      body: reason || undefined,
      footer: '↑↓ select · Enter confirm · Esc = deny',
    },
  );

  if (choice === -1 || choice === options.length - 1) {
    log('INFO', 'permission_denied', { tool, param: primaryValue.slice(0, 200) });
    return 'deny';
  }

  if (choice === 0) {
    // Allow once — no whitelist change
    log('INFO', 'permission_allow_once', { tool, param: primaryValue.slice(0, 200) });
    return 'allow';
  }

  if (choice === 1) {
    // Allow all <tool>
    addToWhitelist(tool);
    return 'allow';
  }

  // Allow with prefix
  const prefixIdx = choice - 2;
  if (prefixIdx >= 0 && prefixIdx < prefixOptions.length) {
    addToWhitelist(tool, prefixOptions[prefixIdx]);
    return 'allow';
  }

  return 'allow';
}