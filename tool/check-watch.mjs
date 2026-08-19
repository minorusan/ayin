#!/usr/bin/env node
/**
 * check-hound — the Claude Code hound's DETERMINISTIC half, against a real git repo.
 *
 * `npm run check:hound` (needs a build first). No LLM, no network: it builds a throwaway Unity-ish
 * repo in the OS temp dir, stages a batch containing every failure mode the hound claims to catch,
 * installs the real hook, and asserts the facts come out. Then it feeds the fact-verifier a
 * fabricated model answer and asserts the contract discards it.
 *
 * It exists because the hound's whole value is that its facts are TRUE. A reviewer that reports a
 * grep it never ran, or reasons about a file that does not exist, is worse than silence: it burns
 * the reader's time re-verifying, and once believed it is a bug shipped with confidence. That
 * failure is invisible to a typecheck and obvious to this test.
 */

// Declare ourselves headless BEFORE importing anything from dist: `watch.js` reaches the llm
// manager, and `ui/index.ts` builds real blessed widgets at module load unless HEADLESS is set —
// which grabs the terminal and leaves escape codes behind when the process exits.
if (!process.argv.includes('-p')) process.argv.push('-p');

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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

// ── a Unity-ish repo with a baseline commit on main ──────────────────

git('init', '-q', '-b', 'main', '.');
git('config', 'user.email', 'hound@test'); git('config', 'user.name', 'hound');
mkdirSync(join(REPO, 'ProjectSettings'), { recursive: true });
write('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.0f1\n');
write('Assets/Scripts/Card.cs', `using UnityEngine;
public enum CardKind { Attack, Defend, Skill }
public interface ICardSink {
    void Push(int id);
}
public class Card : MonoBehaviour {
    [SerializeField] private int oldPower;
    public string cardName;
}
`);
write('Assets/Scripts/Card.cs.meta', 'fileFormatVersion: 2\nguid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
write('Assets/Scripts/Deck.asset', `%YAML 1.1
MonoBehaviour:
  m_Script: {fileID: 11500000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}
  size: 30
`);
write('Assets/Scripts/Game.asmdef', '{"name":"Game","references":["Unity.TextMeshPro","Unity.Addressables"]}\n');
write('AndroidManifest.xml', '<manifest android:label="x" />\n');
git('add', '-A'); git('commit', '-qm', 'baseline');

// A feature branch that has already committed in the area it is working on. The provenance check
// needs exactly this shape: files the branch demonstrably owns, so an outlier stands out.
git('checkout', '-qb', 'feat/cards');
write('Assets/Scripts/Deck.cs', 'public class Deck { }\n');
write('Assets/Scripts/Card.cs.meta', 'fileFormatVersion: 2\nguid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\ntimeCreated: 1\n');
write('Assets/Scripts/Game.asmdef', '{"name":"Game","references":["Unity.TextMeshPro","Unity.Addressables"] }\n');
write('Assets/Scripts/Card.cs', readFileSync(join(REPO, 'Assets/Scripts/Card.cs'), 'utf-8') + '// owned by this branch\n');
git('add', '-A'); git('commit', '-qm', 'add Deck, touch Card');

// ── stage a batch containing every failure mode at once ──────────────

write('Assets/Scripts/Card.cs', `using UnityEngine;
public enum CardKind { Attack, MoveCardBetweenColumns, Defend, Skill }
public interface ICardSink {
    void Push(int id);
    void Flush();
}
public class Card : MonoBehaviour {
    [SerializeField] private int power;
    public string cardName;
}
`);
write('Assets/Scripts/Card.cs.meta', 'fileFormatVersion: 2\nguid: cccccccccccccccccccccccccccccccc\n');
write('Assets/Scripts/Game.asmdef', '{"name":"Game","references":["Unity.TextMeshPro"]}\n');
write('AndroidManifest.xml', '<manifest />\n'); // unrelated work swept into the index
git('add', '-A');

// ── install the real hook and read its facts ─────────────────────────

// The kill switch is GLOBAL (`ayin kill dog` → ~/.ayin-cli/hound.off) and this gate must run a live
// hound, so point the switch at a path inside the throwaway repo: absent for the assertions below,
// and created deliberately for the one that pins the instant pass. Without this the gate goes red on
// any machine whose operator has killed their dog — and the in-process import further down would meet
// the guard's `process.exit(0)` and end the run early, looking green.
const OFF_FILE = join(REPO, 'hound.off');
process.env.AYIN_HOUND_OFF_FILE = OFF_FILE;

const { ensureHoundHook } = await import(`file://${join(ROOT, 'dist', 'watch.js')}`);
ensureHoundHook(REPO);

const hookPath = join(REPO, '.claude', 'hooks', 'ayin-hound.mjs');
const settings = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf-8'));
ok(settings.hooks?.Stop?.length === 1, 'exactly one Stop-hook group installed');
ok(/ayin-hound\.mjs/.test(settings.hooks.Stop[0].hooks[0].command), 'Stop hook points at the node hound');

// ── the kill switch (`ayin kill dog`) ────────────────────────────────
//
// The guard has to be the FIRST thing the script does, or "disabled" still costs a git walk at the end
// of every turn.
ok(readFileSync(hookPath, 'utf-8').includes('AYIN_HOUND_OFF_FILE'),
  'the generated hook carries the kill-switch constant');
writeFileSync(OFF_FILE, 'killed by the gate\n');
const killed = execFileSync('node', [hookPath, '--facts'], { cwd: REPO, encoding: 'utf-8' });
ok(killed.trim() === '', 'with the switch thrown the hook prints NOTHING and exits 0 — the stop passes instantly');
rmSync(OFF_FILE);

const out = execFileSync('node', [hookPath, '--facts'], { cwd: REPO, encoding: 'utf-8' });
const { facts } = JSON.parse(out);
const kinds = facts.map(f => f.kind);
const detail = (kind) => facts.find(f => f.kind === kind)?.detail ?? '';

console.log('\ndeterministic facts');
const foreign = facts.filter(f => f.kind === 'staged-foreign');
ok(foreign.length === 1 && foreign[0].path === 'AndroidManifest.xml',
  'the ONE staged file this branch never touched is flagged, and only it', foreign.map(f => f.path).join(', '));
ok(kinds.includes('meta-guid-changed'), 'a .meta whose guid: line changed is flagged');
ok(/aaaaaaaa/.test(detail('meta-guid-changed')) && /cccccccc/.test(detail('meta-guid-changed')),
  'the guid fact carries both the old and the new guid');
ok(kinds.includes('serialized-field-removed'), 'a removed [SerializeField] is flagged', detail('serialized-field-removed'));
ok(kinds.includes('enum-ordinal-shift'), 'an enum member inserted mid-list is flagged', detail('enum-ordinal-shift'));
ok(kinds.includes('interface-member-added'), 'an interface that gained a member is flagged', detail('interface-member-added'));
ok(kinds.includes('asmdef-reference-removed'), 'a dropped asmdef reference is flagged', detail('asmdef-reference-removed'));

// ── the checks that must STAY QUIET ──────────────────────────────────
// A hound that barks every batch is a hound nobody hears. Unity rewrites .meta files constantly;
// only a changed `guid:` may fire. And appending an enum member is the safe, common case.

console.log('\nquiet when it should be');
git('reset', '-q', '--hard');
write('Assets/Scripts/Card.cs.meta', 'fileFormatVersion: 2\nguid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\ntimeCreated: 1700000000\n');
write('Assets/Scripts/Card.cs', readFileSync(join(REPO, 'Assets/Scripts/Card.cs'), 'utf-8')
  .replace('public enum CardKind { Attack, Defend, Skill }', 'public enum CardKind { Attack, Defend, Skill, Curse }'));
git('add', '-A');
const quiet = JSON.parse(execFileSync('node', [hookPath, '--facts'], { cwd: REPO, encoding: 'utf-8' })).facts;
ok(!quiet.some(f => f.kind === 'meta-guid-changed'), 'a .meta touched WITHOUT a guid change is silent');
ok(!quiet.some(f => f.kind === 'enum-ordinal-shift'), 'an APPENDED enum member is silent');

// ── the anti-fabrication contract ────────────────────────────────────
// The hound's own parser is what makes invented evidence worthless. Exercised by running the hook
// with a stubbed model answer that cites a file which does not exist.

console.log('\ncontract enforcement');
process.env.CLAUDE_PROJECT_DIR = REPO; // the citation check resolves paths against the hook's repo
const src = readFileSync(hookPath, 'utf-8');
const harness = join(REPO, 'contract-harness.mjs');
writeFileSync(harness, src
  .replace(/^#!.*\n/, '')
  .replace(/\nconst argv = process\.argv[\s\S]*$/, '\nexport { parseModelOutput, citedPath };\n'));
const { parseModelOutput } = await import(`file://${harness}`);

const fabricated = parseModelOutput('greps_run: 2\nDebugLogger.cs:42 — callers break — grep DebugLogger\nVERDICT: ISSUES');
ok(fabricated.findings.length === 0, 'a finding citing a non-existent file is dropped');
ok(fabricated.verdict === 'UNVERIFIED', 'ISSUES with no surviving citation degrades to UNVERIFIED');

const noGreps = parseModelOutput('greps_run: 0\nAssets/Scripts/Card.cs:2 — enum shifted — (simulated)\nVERDICT: ISSUES');
ok(noGreps.verdict === 'UNVERIFIED', 'greps_run: 0 forces UNVERIFIED however confident the report');

const real = parseModelOutput('greps_run: 3\nAssets/Scripts/Card.cs:2 — enum shifted — git grep CardKind\nVERDICT: ISSUES');
ok(real.verdict === 'ISSUES' && real.findings.length === 1, 'a cited, grepped finding survives');
ok(real.grepsRun === 3, 'greps_run is parsed');

const clear = parseModelOutput('greps_run: 4\nVERDICT: CLEAR');
ok(clear.verdict === 'CLEAR' && clear.findings.length === 0, 'CLEAR stays CLEAR');

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
