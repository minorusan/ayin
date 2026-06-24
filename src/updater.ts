/**
 * Update checker — queries the npm registry for newer versions.
 * Runs once on startup, non-blocking.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setStatus } from './ui.js';
import { log } from './log.js';

// Update check is OPT-IN: set AYIN_UPDATE_REGISTRY to an npm registry base URL (e.g.
// https://registry.npmjs.org/) to enable it. Empty by default → the check is skipped, so
// a fresh open-source checkout never phones home to any registry.
const REGISTRY = process.env.AYIN_UPDATE_REGISTRY ?? '';
const PACKAGE_NAME = process.env.AYIN_UPDATE_PACKAGE ?? '@maradel/ayin';

function getCurrentVersion(): string {
  try {
    // Read from our own package.json
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

export async function checkForUpdate(): Promise<void> {
  if (!REGISTRY) return; // opt-in only (AYIN_UPDATE_REGISTRY unset) — never phones home by default
  const current = getCurrentVersion();

  try {
    const res = await fetch(`${REGISTRY}${PACKAGE_NAME}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;

    const data = await res.json() as { 'dist-tags'?: { latest?: string } };
    const latest = data['dist-tags']?.latest;
    if (!latest) return;

    if (compareVersions(current, latest) < 0) {
      setStatus({ update: `v${latest} available` });
      log('INFO', 'update_available', { current, latest });
    }
  } catch {
    // Silent — update check is best-effort
  }
}
