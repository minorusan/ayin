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

const SKIP_PERMISSIONS = process.argv.includes('--dangerously-skip-permissions');

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
  if (SKIP_PERMISSIONS || HEADLESS) {
    log('INFO', 'permission_skip', { tool });
    return 'allow';
  }
  if (isWhitelisted(tool, params)) return 'allow';

  const primaryValue = getPrimaryParam(tool, params);
  const preview = primaryValue.length > 50
    ? primaryValue.substring(0, 47) + '...'
    : primaryValue;

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
    options.push({ label: `Allow all ${tool} starting with "${prefix}"` });
  }

  options.push({ label: 'Deny (stop agent)', key: 'n' });

  const reasonLine = reason ? `\n${reason.substring(0, 120)}` : '';
  const choice = await showDialog(
    `${tool}: ${preview}${reasonLine}`,
    options,
  );

  if (choice === -1 || choice === options.length - 1) {
    log('INFO', 'permission_denied', { tool, param: preview });
    return 'deny';
  }

  if (choice === 0) {
    // Allow once — no whitelist change
    log('INFO', 'permission_allow_once', { tool, param: preview });
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