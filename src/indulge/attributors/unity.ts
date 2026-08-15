/**
 * indulge/attributors/unity.ts — what a Unity file IS, said at the moment it is read.
 *
 * Built after watching the agent decide that `DynamicInAppOperation.cs` was a ScriptableObject. It
 * was not an instruction failure — every model knows what `.cs` means. It pattern-matched a NAME
 * that reads like a data asset and never checked the declaration. A sentence in a preamble 40k
 * tokens earlier does not reach that moment.
 *
 * So this states what the file is, in the middle of the thing being read, derived from the bytes
 * already in hand. No advice, no reminders, no "remember that in Unity…". A fact, where the mistake
 * happens.
 *
 * Everything here is the cheap half: parsing a base-type list out of source already loaded. The
 * expensive half — which prefabs reference this script, how many `.asset` instances exist — is
 * `indulgers/unity.ts`, run overnight, and read back from the chunk for free.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AttributionContext, Attributor } from '../hooks/types.js';

/** Unity's own marker. Present in every project, absent everywhere else. */
export function isUnityProject(repoPath: string): boolean {
  return existsSync(join(repoPath, 'ProjectSettings', 'ProjectVersion.txt'))
    || existsSync(join(repoPath, 'Assets')) && existsSync(join(repoPath, 'ProjectSettings'));
}

/** `class Foo : Bar, IBaz` → `['Bar', 'IBaz']`. Generic args and whitespace tolerated. */
export function baseTypesOf(source: string, typeName: string): string[] {
  const re = new RegExp(
    `\\b(?:class|struct|interface)\\s+${typeName}\\b[^\\{:]*:\\s*([^\\{]+)`, 'm',
  );
  const m = source.match(re);
  if (!m) return [];
  return m[1]
    .replace(/where[\s\S]*$/, '')          // generic constraints are not base types
    .split(',')
    .map((t) => t.trim().replace(/<.*>$/, ''))
    .filter(Boolean);
}

/** The first declared type in a file — Unity requires the file name to match it, so this is it. */
export function primaryTypeOf(source: string, file: string): { name: string; kind: string } | null {
  const expected = file.split('/').pop()?.replace(/\.cs$/i, '') ?? '';
  const declRe = /\b(class|struct|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let fallback: { name: string; kind: string } | null = null;
  for (const m of source.matchAll(declRe)) {
    const found = { kind: m[1], name: m[2] };
    if (found.name === expected) return found;     // the one Unity cares about
    if (!fallback) fallback = found;
  }
  return fallback;
}

const UNITY_BASES: Record<string, string> = {
  MonoBehaviour: 'a MonoBehaviour — attached to GameObjects in scenes and prefabs',
  ScriptableObject: 'a ScriptableObject — instances are .asset files, not scene objects',
  Editor: 'a custom Editor — editor-only, not in a build',
  EditorWindow: 'an EditorWindow — editor-only, not in a build',
  PropertyDrawer: 'a PropertyDrawer — editor-only, not in a build',
  NetworkBehaviour: 'a NetworkBehaviour — networked component',
};

export const unityAttributor: Attributor = {
  id: 'unity',

  applies(repoPath) {
    return isUnityProject(repoPath);
  },

  sessionPreamble() {
    // ONE line, once per session. The moment this grows into a manual it has become the preamble
    // this mechanism exists to replace.
    return 'Unity project: .cs files are source; .asset/.prefab/.unity are serialized data; every file has a .meta holding its GUID, and references between assets are by GUID.';
  },

  attribute(ctx: AttributionContext): string | null {
    const lower = ctx.file.toLowerCase();

    if (lower.endsWith('.meta')) {
      return 'Unity .meta sidecar — a GUID and import settings for the file beside it. No behaviour.';
    }
    if (/\.(asset|prefab|unity|mat|anim|controller)$/.test(lower)) {
      return `Unity serialized data (${lower.split('.').pop()}), not code. Its m_Script guid names the class it instantiates.`;
    }
    if (!lower.endsWith('.cs') || !ctx.source) return null;

    const primary = primaryTypeOf(ctx.source, ctx.file);
    if (!primary) return null;

    const bases = baseTypesOf(ctx.source, primary.name);
    const known = bases.find((b) => UNITY_BASES[b]);

    const parts: string[] = [`C# source · ${primary.kind} ${primary.name}`];
    if (known) {
      parts.push(UNITY_BASES[known]);
    } else if (primary.kind === 'interface') {
      parts.push('an interface — no instances of its own');
    } else if (bases.length) {
      parts.push(`derives from ${bases.join(', ')} — no Unity base type`);
    } else {
      // The exact failure: a plain class whose NAME reads like a data asset.
      parts.push('plain class, no Unity base type — not a ScriptableObject, not a MonoBehaviour');
    }

    // The overnight half, if the corpus covered this file. Free: it is already in the chunk.
    const ext = ctx.chunks.map((c) => (c.ext as Record<string, unknown> | undefined)?.unity)
      .find((u): u is Record<string, unknown> => Boolean(u));
    if (ext) {
      const refs = ext.referencedBy as string[] | undefined;
      const total = ext.referencedByTotal as number | undefined;
      const asOf = ext.asOf as string | undefined;
      if (typeof total === 'number') {
        const sample = refs?.length ? ` (${refs.slice(0, 3).join(', ')}${total > 3 ? ', …' : ''})` : '';
        parts.push(`referenced by ${total} asset(s)${sample}${asOf ? ` as of ${asOf.slice(0, 10)}` : ''}`);
      }
    }
    return parts.join(' · ');
  },
};
