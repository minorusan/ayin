#!/usr/bin/env node
/**
 * check-refs — `find_references`, against real repositories built in the temp directory.
 *
 * `npm run check:refs` (needs a build first). No LLM, no network.
 *
 * THE CASE WORTH A GATE is the Unity one, because it is the one no text search reaches: a script is
 * instantiated from a prefab by a guid that appears nowhere in the script, so grepping the class name
 * finds the C# and misses the prefab entirely. If that link ever silently stops resolving, the tool
 * still answers — with a shorter list — and "no references" is exactly the answer somebody deletes a
 * file on. So the fixture builds a real Assets/ tree with a real .meta and asserts the prefab is found,
 * by its m_Script key.
 *
 * AND THE TWO WAYS IT HAS ALREADY LIED. Both were found the first time it ran against a real project:
 * a grep over a whole Unity tree hit its timeout and returned nothing, which reads as "nothing
 * references this"; and macOS grep prints paths without the `./` that the parser required, so every
 * hit was dropped. Both are asserted here as behaviour, not as implementation.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { unityFinder, guidOf, assetForGuid } = await import(join(ROOT, 'dist/indulge/finders/unity.js'));
const { codeFinder, declaredNames } = await import(join(ROOT, 'dist/indulge/finders/code.js'));

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const TMP = mkdtempSync(join(tmpdir(), 'ayin-refs-'));
const GUID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

// ── a Unity project, as small as one can be and still be one ──────────────────
const U = join(TMP, 'unity');
mkdirSync(join(U, 'Assets', 'Scripts'), { recursive: true });
mkdirSync(join(U, 'Assets', 'Prefabs'), { recursive: true });
mkdirSync(join(U, 'ProjectSettings'), { recursive: true });
writeFileSync(join(U, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.20f1\n');
writeFileSync(join(U, 'Assets', 'Scripts', 'PlayerHud.cs'), 'using UnityEngine;\npublic class PlayerHud : MonoBehaviour { void Awake() {} }\n');
writeFileSync(join(U, 'Assets', 'Scripts', 'PlayerHud.cs.meta'), `fileFormatVersion: 2\nguid: ${GUID}\nMonoImporter:\n`);
writeFileSync(join(U, 'Assets', 'Prefabs', 'Hud.prefab'), [
  '%YAML 1.1', '--- !u!114 &11400000', 'MonoBehaviour:', '  m_GameObject: {fileID: 0}',
  `  m_Script: {fileID: 11500000, guid: ${GUID}, type: 3}`, '  _label: hello', '',
].join('\n'));
// A file that merely NAMES the class, which is the other, weaker kind of reference.
writeFileSync(join(U, 'Assets', 'Scripts', 'HudSpawner.cs'), 'public class HudSpawner { PlayerHud hud; }\n');

console.log('\n— the reference no text search can reach —');
ok(unityFinder.applies(U), 'a tree with Assets/ and ProjectSettings/ is a Unity project');
ok(guidOf(U, join(U, 'Assets/Scripts/PlayerHud.cs')) === GUID, 'the guid is read from the .meta beside the file');
ok(unityFinder.handles(join(U, 'Assets/Scripts/PlayerHud.cs'), U), 'so the finder claims the script');
{
  const hits = unityFinder.find(join(U, 'Assets/Scripts/PlayerHud.cs'), U, 20);
  const prefab = hits.find((h) => h.path.endsWith('Hud.prefab'));
  ok(!!prefab, 'the PREFAB is found — the link that exists only as a guid', JSON.stringify(hits));
  ok(prefab?.how === 'm_Script', '  → and named by the key that owns it, not just "contains the guid"', prefab?.how);
  ok(prefab?.line === 5, '  → at the right line', String(prefab?.line));
}
ok(assetForGuid(U, GUID)?.endsWith('Assets/Scripts/PlayerHud.cs'), 'and a bare guid resolves back to its asset — the reverse lookup');
ok(assetForGuid(U, 'f'.repeat(32)) === null, 'a guid nothing declares resolves to nothing, rather than to a guess');

console.log('\n— the source half, in whatever language claims the file —');
ok(declaredNames(join(U, 'Assets/Scripts/PlayerHud.cs')).includes('PlayerHud'), 'the type a file declares is what others must name');
{
  const hits = codeFinder.find(join(U, 'Assets/Scripts/PlayerHud.cs'), U, 20);
  ok(hits.some((h) => h.path.endsWith('HudSpawner.cs')), 'a file naming the class is a hit', JSON.stringify(hits));
  ok(!hits.some((h) => h.path.endsWith('Scripts/PlayerHud.cs')), 'and the declaring file is not a reference to ITSELF');
}

console.log('\n— the two ways it has already lied —');
{
  /**
   * macOS grep prints `Assets/x.cs:9:…`; GNU grep prints `./Assets/x.cs:9:…`. A parser anchored on
   * the `./` matched nothing on a Mac and returned an empty list, which reads as "nothing references
   * this" — the answer somebody deletes a file on.
   */
  const hits = codeFinder.find(join(U, 'Assets/Scripts/PlayerHud.cs'), U, 20);
  ok(hits.length > 0, 'grep output parses whether or not the platform prefixes paths with ./');
  ok(hits.every((h) => !h.path.startsWith('./') && !h.path.startsWith('/')), '  → and every path comes back repo-relative', JSON.stringify(hits.map((h) => h.path)));
}
{
  // A stem that is an ENGLISH WORD is not a symbol. Searching for it returns prose and calls it a
  // reference: measured, `unity.ts` searched this repository for "unity" and matched three gate
  // scripts' comments.
  const W = join(TMP, 'words');
  mkdirSync(W, { recursive: true });
  writeFileSync(join(W, 'unity.ts'), 'export const thing = 1;\n');
  writeFileSync(join(W, 'PlayerHud.ts'), 'export const other = 2;\n');
  ok(declaredNames(join(W, 'unity.ts')).length === 0, 'a file whose name is a plain word is not searched for by name');
  ok(declaredNames(join(W, 'PlayerHud.ts')).includes('PlayerHud'), '  → while a name shaped like a symbol still is');
}

console.log('\n— a repo that is not Unity simply never asks the Unity finder —');
{
  const P = join(TMP, 'plain');
  mkdirSync(P, { recursive: true });
  writeFileSync(join(P, 'a.ts'), 'export class Widget {}\n');
  ok(!unityFinder.applies(P), 'no Assets/ + ProjectSettings/, no Unity finder');
  ok(codeFinder.applies(P), 'and the source finder applies everywhere');
}

rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\nrefs check: ${fails} FAILED` : '\nrefs check: all passed');
process.exit(fails ? 1 : 0);
