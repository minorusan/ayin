/**
 * `find_references` — who points AT this file, rather than what it points at.
 *
 * The reverse of every other read tool here, and the one nothing answered. `explore` finds a file
 * from a description, `read_file` opens it, `prefab_inspect` resolves what it references — and the
 * question an engineer asks before touching anything, *what breaks if I change this*, had no tool at
 * all. Reported as friction twice by the model working in a real Unity project.
 *
 * TWO FINDERS, ASKED IN ORDER, because the answer has two halves that no single search reaches:
 *
 *   `unity`  a script is instantiated from a prefab by a GUID that appears NOWHERE in the script.
 *            Grep the class name and the prefab is invisible. The guid lives in the `.meta` sidecar,
 *            and this resolves it and searches the serialized formats for it. Any asset with a
 *            `.meta` works — a sprite, a material, a ScriptableObject — and a bare 32-hex guid is a
 *            valid target too, which is the reverse lookup ("what IS this guid") in the same call.
 *   `code`   who NAMES the types this file declares, in any of the nine languages `languageFor`
 *            already knows. It reuses entangle's `surfaceOf` rather than parsing again, so a tenth
 *            language arrives here the moment it arrives there.
 *
 * A finder that does not apply is silent, and a repo that is not Unity simply never asks the first
 * one. Packs in `~/.ayin-cli/finders/` override a built-in by id, exactly as attributors do.
 *
 * WHAT IT DOES NOT CLAIM. The code half is a TEXT search: no compiler here resolves imports or
 * overloads, so a hit is a mention, and a comment naming the class is a hit. The output says which
 * finder produced each group and what it searched, because a confident list that quietly includes a
 * comment is worse than an honest one that labels it.
 */

import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { Tool } from '../base.js';
import { findersFor } from '../../indulge/hooks/registry.js';
import { assetForGuid } from '../../indulge/finders/unity.js';
import { projectRoot } from '../../qa/probes.js';
import { resolveAgainstCwd } from '../lib.js';

/** Hits per finder. Past this the answer stops being a list and becomes a file to read. */
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

const GUID = /^[0-9a-f]{32}$/;

export const tool: Tool = {
  name: 'find_references',
  icon: '🔗',
  description:
    'WHO POINTS AT THIS — the reverse of reading a file. Give it a path and it returns every place '
    + 'that references it: for a Unity asset, the prefabs and scenes that use it (resolved through the '
    + '.meta GUID, which no text search for the class name can find), and for source, every file that '
    + 'names the types it declares, in C#, TypeScript, Dart, Python, Go, Rust, Ruby, Java or C++. Ask '
    + 'it before changing or deleting anything: "what breaks if I touch this". A bare 32-hex GUID is '
    + 'also a valid target — it answers which asset that is, and who references it. Read-only.',
  parameters: [
    { name: 'target', type: 'string', description: 'The file to find references TO — a path, absolute or relative to the cwd. Or a bare 32-character Unity GUID.', required: true },
    { name: 'limit', type: 'number', description: `Max hits per finder (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`, required: false },
  ],

  async execute(params) {
    const target = String(params.target ?? '').trim();
    if (!target) return 'Error: target required';

    const asked = Number(params.limit);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_LIMIT) : DEFAULT_LIMIT;

    const isGuid = GUID.test(target);
    const abs = isGuid ? target : resolveAgainstCwd(target);
    if (!isGuid && !existsSync(abs)) return `Error: file not found: ${target}`;

    // The repository, not the cwd: references live anywhere in the project, and a tool run from a
    // subdirectory must not answer only for that subdirectory.
    // A DIRECTORY, not the file. `projectRoot` shells out to `git -C <path> rev-parse`, which fails on
    // a file path — and a failed lookup falls back to somewhere that is not the repository, so every
    // finder then searched the wrong tree and answered "no references" about a class with dozens.
    const root = projectRoot(isGuid ? process.cwd() : dirname(abs)) || process.cwd();
    const shown = isGuid ? target : relative(root, resolve(abs)) || target;

    const finders = findersFor(root).filter((f) => {
      try { return f.handles(isGuid ? target : abs, root); } catch { return false; }
    });

    const out: string[] = [];
    // A GUID NAMES SOMETHING, and saying what it is comes before saying who uses it.
    if (isGuid) {
      const asset = assetForGuid(root, target);
      out.push(asset ? `guid ${target} is ${asset}` : `guid ${target} — no .meta in this project declares it`);
    }

    if (finders.length === 0) {
      out.push(`No finder can answer for ${shown}.`);
      out.push('A Unity asset needs a .meta beside it; a source file needs to declare a type in a language'
        + ' ayin parses (C#, TypeScript, Dart, Python, Go, Rust, Ruby, Java, C++).');
      return out.join('\n');
    }

    let total = 0;
    for (const finder of finders) {
      let hits;
      try {
        hits = finder.find(isGuid ? target : abs, root, limit);
      } catch (err) {
        // A broken finder degrades the answer; it never costs the other one.
        out.push('', `[${finder.id}] failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      out.push('', `[${finder.id}] ${finder.describe(isGuid ? target : abs, root)}`);
      if (hits.length === 0) { out.push('  no references found'); continue; }
      total += hits.length;
      for (const h of hits) out.push(`  ${h.path}${h.line ? `:${h.line}` : ''}  ·  ${h.how}`);
      if (hits.length >= limit) out.push(`  … stopped at ${limit} — raise limit= for more`);
    }

    out.unshift(`References to ${shown} — ${total} hit(s) from ${finders.length} finder(s)`);
    return out.join('\n');
  },
};
