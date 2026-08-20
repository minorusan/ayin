#!/usr/bin/env node
/**
 * check-watch — the Claude Code hound's ONE question, and the autostage allowlist, against a real repo.
 *
 * `npm run check:watch` (needs a build first). No LLM, no network: it builds a throwaway Unity-ish
 * repo in the OS temp dir, installs the real hook, and drives the hound through every branch of the
 * one question it asks — does every C# type ADDED in the working tree appear on the design?
 *
 * It exists because a hook that fires at the end of every turn is judged entirely on its false
 * positives. The nudge has to be silent for a tracked edit, silent for build output, silent when the
 * tree has no design, and silent when the type IS on the diagram — and it has to fire on an
 * untracked new type that is not. Each of those is one assertion here and invisible to a typecheck.
 */

// Declare ourselves headless BEFORE importing anything from dist: `watch.js` reaches the llm
// manager, and `ui/index.ts` builds real blessed widgets at module load unless HEADLESS is set —
// which grabs the terminal and leaves escape codes behind when the process exits.
if (!process.argv.includes('-p')) process.argv.push('-p');

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = mkdtempSync(join(tmpdir(), 'ayin-hound-'));

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
const write = (rel, body) => {
  mkdirSync(dirname(join(REPO, rel)), { recursive: true });
  writeFileSync(join(REPO, rel), body);
};

// ── a Unity-ish repo with a design and a baseline commit ─────────────

git('init', '-q', '-b', 'main', '.');
git('config', 'user.email', 'hound@test'); git('config', 'user.name', 'hound');
mkdirSync(join(REPO, 'ProjectSettings'), { recursive: true });
write('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.0f1\n');

// The design, in the format naama writes and entangle reads. `Ghost` is deliberately NOT on it.
write('Design/Rewards.puml', `@startuml
' naamah:title Rewards
' naamah:domain Rewards refs=NONE sealed
package "Rewards" {
  interface IRewardService {
    +Grant(int id)
  }
  class RewardService {
    +Grant(int id)
    -_live : List<Entry>
  }
  enum RewardKind {
  }
  abstract class RewardBase
  struct Entry
}
RewardService ..> IRewardService
@enduml
`);

write('Assets/Scripts/Card.cs', `using UnityEngine;
public class Card : MonoBehaviour {
    public string cardName;
}
`);
write('Assets/Scripts/Game.asmdef', '{"name":"Game","references":["Unity.TextMeshPro","Unity.Addressables"]}\n');
write('Assets/Scripts/Deck.asset', `%YAML 1.1
MonoBehaviour:
  m_Script: {fileID: 11500000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}
`);
write('Assets/Scripts/Card.cs.meta', 'fileFormatVersion: 2\nguid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
git('add', '-A'); git('commit', '-qm', 'baseline');

// ── install the real hook ────────────────────────────────────────────

// The kill switch is GLOBAL (`ayin kill dog` → ~/.ayin-cli/hound.off) and this gate must run a live
// hound, so point the switch at a path inside the throwaway repo: absent for the assertions below,
// and created deliberately for the one that pins the instant pass. Without this the gate goes red on
// any machine whose operator has killed their dog.
const OFF_FILE = join(REPO, 'hound.off');
process.env.AYIN_HOUND_OFF_FILE = OFF_FILE;
// The debounce lock too: keyed on the FINDING, so this fixture produces the same key on every run
// and the shared OS tmpdir would suppress the nudge for a day after the first green run. Measured —
// the gate passed once and then reported three failures until the lock aged out.
const LOCK_DIR = join(REPO, 'locks');
mkdirSync(LOCK_DIR, { recursive: true });
process.env.AYIN_HOUND_LOCK_DIR = LOCK_DIR;

const { ensureHoundHook } = await import(`file://${join(ROOT, 'dist', 'watch.js')}`);
ensureHoundHook(REPO);

const hookPath = join(REPO, '.claude', 'hooks', 'ayin-hound.mjs');
const settings = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf-8'));
ok(settings.hooks?.Stop?.length === 1, 'exactly one Stop-hook group installed');
ok(/ayin-hound\.mjs/.test(settings.hooks.Stop[0].hooks[0].command), 'Stop hook points at the node hound');

const hookSrc = readFileSync(hookPath, 'utf-8');
ok(hookSrc.includes('AYIN_HOUND_NUDGE'), 'the generated hook carries the nudge template');
ok(!/spawnSync\(\s*'ayin'/.test(hookSrc), 'the hook calls NO model — the whole answer is deterministic');

/** The hook's own verdict, as JSON. */
const facts = (...args) => JSON.parse(execFileSync('node', [hookPath, '--facts', ...args], { cwd: REPO, encoding: 'utf-8' }));
/** The hook as Claude Code runs it: payload on stdin, JSON or nothing on stdout. */
const run = () => execFileSync('node', [hookPath], { cwd: REPO, encoding: 'utf-8', input: '{}' });

// ── the kill switch (`ayin kill dog`) ────────────────────────────────
// The guard has to be the FIRST thing the script does, or "disabled" still costs a git walk at the
// end of every turn.

console.log('\nkill switch');
write('Assets/Scripts/Ghost.cs', 'public class Ghost { }\n');
writeFileSync(OFF_FILE, 'killed by the gate\n');
ok(execFileSync('node', [hookPath, '--facts'], { cwd: REPO, encoding: 'utf-8' }).trim() === '',
  'with the switch thrown the hook prints NOTHING and exits 0 — the stop passes instantly');
unlinkSync(OFF_FILE);

// ── the one question ─────────────────────────────────────────────────

console.log('\nan added type that is not on the design');
let f = facts();
ok(f.addedCs.includes('Assets/Scripts/Ghost.cs'), 'an UNTRACKED new .cs counts as added', f.addedCs.join(', '));
ok(f.designSources.includes('Design/Rewards.puml'), 'the .puml design in the tree was found', f.designSources.join(', '));
ok(f.designedTypes.join(',') === 'Entry,IRewardService,RewardBase,RewardKind,RewardService',
  'every puml kind is read — class, interface, enum, abstract class, struct', f.designedTypes.join(','));
ok(f.undesigned.length === 1 && f.undesigned[0].type === 'Ghost', 'the undesigned type is named, with its file',
  JSON.stringify(f.undesigned));

const nudge = JSON.parse(run() || '{}');
ok(nudge.hookSpecificOutput?.hookEventName === 'Stop', 'the finding rides out as a Stop hook context block');
ok(!('decision' in nudge), 'it NEVER blocks — a nudge costs no turn');
ok(/Ghost/.test(nudge.hookSpecificOutput?.additionalContext ?? ''), 'the nudge names the type');
ok(/Rewards\.puml/.test(nudge.hookSpecificOutput?.additionalContext ?? ''), 'the nudge names the design');
ok(!/\{\{[A-Z_]+\}\}/.test(nudge.hookSpecificOutput?.additionalContext ?? ''),
  'every {{VAR}} in the template was filled', nudge.hookSpecificOutput?.additionalContext);

console.log('\ndebounce');
ok(run().trim() === '', 'the SAME finding a second time is silent — a hound that repeats is unread');

// ── the four ways it must stay silent ────────────────────────────────
// A hook that fires at the end of every turn is judged on its false positives.

console.log('\nquiet when it should be');
unlinkSync(join(REPO, 'Assets/Scripts/Ghost.cs'));

write('Assets/Scripts/RewardService.cs', 'public class RewardService { public void Grant(int id) { } }\n');
ok(facts().undesigned.length === 0, 'a new type that IS on the design is silent');
ok(run().trim() === '', '…and emits nothing at all');
unlinkSync(join(REPO, 'Assets/Scripts/RewardService.cs'));

write('Assets/Scripts/Card.cs', readFileSync(join(REPO, 'Assets/Scripts/Card.cs'), 'utf-8') + '// edited\n');
f = facts();
ok(f.addedCs.length === 0, 'an EDITED tracked .cs is not an add — Card is never re-asked', f.addedCs.join(', '));
ok(run().trim() === '', '…and emits nothing at all');
git('checkout', '-q', '--', 'Assets/Scripts/Card.cs');

write('Library/ScriptAssemblies/Generated.cs', 'public class Generated { }\n');
write('obj/Debug/Stub.cs', 'public class Stub { }\n');
write('Assets/Scripts/View.designer.cs', 'public class View { }\n');
f = facts();
ok(f.addedCs.length === 0, 'build output and generated .cs are never authored decisions', f.addedCs.join(', '));
rmSync(join(REPO, 'Library'), { recursive: true, force: true });
rmSync(join(REPO, 'obj'), { recursive: true, force: true });
unlinkSync(join(REPO, 'Assets/Scripts/View.designer.cs'));

write('Assets/Scripts/Ghost.cs', 'public class Ghost { }\n');
const designPath = join(REPO, 'Design/Rewards.puml');
const designSrc = readFileSync(designPath, 'utf-8');
rmSync(designPath);
f = facts();
ok(f.designSources.length === 0 && f.undesigned.length === 0,
  'with NO design in the tree there is nothing to be off — silent');
ok(run().trim() === '', '…and emits nothing at all');

// A .puml that declares no type is a diagram, not a design: it must not make every added type look
// undesigned. This is what stops a sequence diagram from turning the hook into a firehose.
write('Design/Flow.puml', '@startuml\nAlice -> Bob: hello\n@enduml\n');
f = facts();
ok(f.designSources.length === 0, 'a .puml declaring no type does not count as a design', f.designSources.join(', '));
rmSync(join(REPO, 'Design/Flow.puml'));
writeFileSync(designPath, designSrc);

// A rendered naamah page is the fallback when no .puml declares anything.
console.log('\nthe rendered page as fallback');
rmSync(designPath);
write('Design/Rewards.html', '<html><script id="graph" type="application/json">'
  + JSON.stringify({ nodes: [{ id: 'n1', name: 'RewardService', kind: 'class' }, { id: 'n2', name: 'Aside', kind: 'note' }] })
  + '</script></html>\n');
f = facts();
ok(f.designSources.includes('Design/Rewards.html'), 'a rendered naamah page is read when no .puml declares a type');
ok(f.designedTypes.join(',') === 'RewardService', 'a note is not a type');
ok(f.undesigned.some(u => u.type === 'Ghost'), 'the question is still answered against it');
rmSync(join(REPO, 'Design/Rewards.html'));
writeFileSync(designPath, designSrc);
unlinkSync(join(REPO, 'Assets/Scripts/Ghost.cs'));

// ── staged additions, and what is NOT an add ─────────────────────────

console.log('\nthe index half');
write('Assets/Scripts/Wraith.cs', 'internal sealed partial class Wraith { }\n');
git('add', 'Assets/Scripts/Wraith.cs');
f = facts();
ok(f.addedCs.includes('Assets/Scripts/Wraith.cs'), 'a file STAGED as an addition counts as added');
ok(f.undesigned.some(u => u.type === 'Wraith'), 'modifiers in any order still yield the name');
git('rm', '-q', '--cached', 'Assets/Scripts/Wraith.cs'); unlinkSync(join(REPO, 'Assets/Scripts/Wraith.cs'));

git('mv', 'Assets/Scripts/Card.cs', 'Assets/Scripts/PlayingCard.cs');
f = facts();
ok(f.addedCs.length === 0, 'a RENAME is not an add — the type was answered under its old path', f.addedCs.join(', '));
git('reset', '-q', '--hard');

// ── the autostage allowlist ──────────────────────────────────────────
// The other half of what `ayin watch` writes into a repo: what it puts in the INDEX. Three kinds
// and nothing else — animator controllers/clips, custom ScriptableObject assets, and .cs that adds
// no debug code. Everything the allowlist rejects here is a file a developer found in their index
// and did not put there, which is the complaint this list exists to answer.

console.log('\nautostage allowlist (Unity)');
const { unityStageReason } = await import(`file://${join(ROOT, 'dist', 'watch.js')}`);
git('reset', '-q', '--hard');
const cache = new Map();
const reason = (rel, tracked = true) => unityStageReason(REPO, rel, tracked, cache);

write('Assets/Anim/Card.controller', 'AnimatorController:\n  m_Name: Card\n');
write('Assets/Prefabs/Hero.prefab', '%YAML 1.1\nGameObject:\n  m_Name: Hero\n');
write('Assets/Data/LightingData.asset', '%YAML 1.1\nLightingDataAsset:\n  m_Name: LightingData\n');
write('Assets/Data/Packaged.asset', '%YAML 1.1\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: ffffffffffffffffffffffffffffffff, type: 3}\n');
write('ProjectSettings/Custom.asset', '%YAML 1.1\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}\n');
write('Assets/Scripts/Noisy.cs', 'public class Noisy {\n  void Go() { UnityEngine.Debug.Log("here"); }\n}\n');
write('Assets/Scripts/Clean.cs', 'public class Clean {\n  void Go() { UnityEngine.Debug.LogError("real failure"); }\n}\n');

ok(await reason('Assets/Anim/Card.controller', false), 'an animator controller is staged');
ok(await reason('Assets/Scripts/Deck.asset') === 'custom ScriptableObject asset',
  'a .asset whose m_Script guid resolves to a project .cs is staged');
ok(await reason('Assets/Data/Packaged.asset', false) === null,
  'a .asset whose m_Script guid is NOT a project script is left alone');
ok(await reason('Assets/Data/LightingData.asset', false) === null,
  'a .asset that is not a ScriptableObject at all (baked data) is left alone');
ok(await reason('ProjectSettings/Custom.asset', false) === null,
  'a ScriptableObject OUTSIDE Assets/ is left alone');
ok(await reason('Assets/Prefabs/Hero.prefab', false) === null, 'a prefab is never auto-staged');
ok(await reason('Assets/Scripts/Noisy.cs', false) === null, 'a .cs that adds Debug.Log is left alone');
ok(await reason('Assets/Scripts/Clean.cs', false), 'a .cs whose only log is Debug.LogError is staged');
ok(await reason('Assets/Scripts/Card.cs') , 'an unmodified tracked .cs qualifies (no added debug lines)');

// Debug code added to a TRACKED file is judged on the added lines, not the whole file.
write('Assets/Scripts/Card.cs', readFileSync(join(REPO, 'Assets/Scripts/Card.cs'), 'utf-8') + '// print(x) in a comment\n');
ok(await reason('Assets/Scripts/Card.cs'), 'a commented-out print does not disqualify a tracked .cs');
write('Assets/Scripts/Card.cs', readFileSync(join(REPO, 'Assets/Scripts/Card.cs'), 'utf-8').replace('public class Card', 'public class Card // x\n// filler') + '\npublic class Extra { void A() { UnityEngine.Debug.Log(1); } }\n');
ok(await reason('Assets/Scripts/Card.cs') === null, 'a tracked .cs that ADDS a Debug.Log is left alone');

rmSync(REPO, { recursive: true, force: true });
console.log(fails ? `\nwatch check: ${fails} FAILURE(S)\n` : '\nwatch check: ok\n');
process.exit(fails ? 1 : 0);
