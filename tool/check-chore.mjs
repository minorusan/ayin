#!/usr/bin/env node
/**
 * check-chore — the dead-code report, against a git history built for the occasion.
 *
 * `npm run check:chore` (needs a build). HERMETIC: it creates a real repository in a temp directory and
 * makes real commits, because every claim this tool makes is a claim about history and a fixture without
 * history could not test any of them.
 *
 * The four things that decide whether the report is worth reading:
 *   · ADDED, not merely present. A member that was already there is not a finding, or every scan reports
 *     the whole file.
 *   · RE-CHECKED against HEAD. Added in one commit and deleted in a later one is history; reporting it
 *     sends someone looking for code that is not there.
 *   · USED means used ANYWHERE, assets included — a Unity field is named from a prefab, not from C#.
 *   · REFLECTION-INVOKED members are excluded and COUNTED. An NUnit [Test] has no callers by design, and
 *     a report whose top items are tests is a report nobody reads twice.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const { runChore } = await import(`file://${join(DIST, 'chore', 'index.js')}`);
const { renderChoreText, renderChorePage } = await import(`file://${join(DIST, 'chore', 'render.js')}`);

const repo = mkdtempSync(join(tmpdir(), 'ayin-chore-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
const w = (rel, text) => { mkdirSync(join(repo, dirname(rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
const commit = (msg) => { git('add', '-A'); git('-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', msg); };

git('init', '-q', '-b', 'main');

// ── commit 1: the code that was already here. It sits OUTSIDE the range asked for below, which is the
// only honest way to test "already there" — inside the range it genuinely was added recently.
w('src/Existing.cs', `public class Existing {
    public void AlreadyHere() { }
    private int _alreadyHere;
}
`);
commit('first');

// ── commit 2: the additions under test.
w('src/Widget.cs', `using NUnit.Framework;

public class Widget {
    // Nothing calls this.
    public void NeverCalled() { }

    // Called from Caller.cs, added in the same commit.
    public void IsCalled() { }

    // Named from a prefab, not from C#.
    [SerializeField]
    private int _serialized;

    // NUnit calls this by reflection.
    [Test]
    public void ATestThatPasses() { }

    // Deleted again in commit 3.
    public void Doomed() { }

    private float _deadField;
}
`);
// Go and IsCalled reference each other. Both are added in this commit and neither is a finding, which
// is what "used ANYWHERE counts" has to mean — a reference is a reference, wherever it is.
w('src/Caller.cs', `public class Caller {
    void Go() { new Widget().IsCalled(); }
}
`);
w('Assets/Thing.prefab', `%YAML 1.1
--- !u!114 &1
MonoBehaviour:
  _serialized: 7
`);
commit('add the widget');

// ── commit 3: Doomed is removed again — history, not dead code.
w('src/Widget.cs', `using NUnit.Framework;

public class Widget {
    // Nothing calls this.
    public void NeverCalled() { }

    // Called from Caller.cs, added in the same commit.
    public void IsCalled() { new Caller().Go(); }

    // Named from a prefab, not from C#.
    [SerializeField]
    private int _serialized;

    // NUnit calls this by reflection.
    [Test]
    public void ATestThatPasses() { }

    private float _deadField;
}
`);
commit('drop the doomed one');

const r = runChore({ repo, commits: 2 });   // commit 1 is deliberately out of range
const names = r.findings.map((f) => f.name).sort();

console.log('\nwhat is a finding');
ok(r.commits.length === 2, 'only the range asked for is read', String(r.commits.length));
ok(names.join(',') === 'NeverCalled,_deadField',
  'exactly the added members nothing uses — a method and a field', names.join(',') || '(none)');
ok(!names.includes('AlreadyHere') && !names.includes('_alreadyHere'),
  'a member from OUTSIDE the range is never reported, however dead it is — this is a scan of recent work');
ok(!names.includes('IsCalled') && !names.includes('Go'),
  'members that reference each other are both used — a reference is a reference, wherever it is');
ok(!names.includes('_serialized'),
  'a field NAMED FROM A PREFAB is not dead — assets are searched, not just C#');
ok(!names.includes('ATestThatPasses'),
  'an NUnit [Test] is excluded: it has no callers by design, and the attribute is on the line ABOVE');
ok(!names.includes('Doomed'),
  'a member added and then deleted again is history — the HEAD re-check drops it');
ok(r.skipped.some((s) => /added and then removed/.test(s)), 'and the report says one was dropped for that reason');
ok(r.skipped.some((s) => /reflection/.test(s)), 'and how many were excluded as reflection-invoked');

console.log('\nwhat a finding carries');
const dead = r.findings.find((f) => f.name === 'NeverCalled');
ok(dead.kind === 'method' && dead.file === 'src/Widget.cs',
  'its kind and the file it lives in', `${dead.kind} ${dead.file}`);
ok(dead.line > 0, 'a line number from HEAD, not from the diff', String(dead.line));
ok(dead.commit.sha.length >= 7 && dead.commit.subject === 'add the widget',
  'the commit that introduced it — the half that makes it actionable',
  `${dead.commit.sha} ${dead.commit.subject}`);
ok(dead.declaration.includes('public void NeverCalled'), 'and the declaration as written');
ok(dead.uses === 0 && dead.assetRefs.length === 0, 'with the reference counts that justify the verdict');
ok(dead.confidence === 'possible' && dead.caveats.some((c) => /public/.test(c)),
  'a public member is "possible", never "likely" — it may be used outside this repository',
  `${dead.confidence} · ${dead.caveats.join(' | ')}`);
const field = r.findings.find((f) => f.name === '_deadField');
ok(field.confidence === 'likely' && field.caveats.length === 0,
  'a private field with nothing to excuse it is the confident case', field.confidence);
ok(r.findings[0].confidence === 'likely', 'and confident findings sort first', r.findings[0].name);

console.log('\nincludeUsed, for auditing the scan itself');
const all = runChore({ repo, commits: 2, includeUsed: true });
const allNames = all.findings.map((f) => f.name);
ok(allNames.includes('IsCalled') && allNames.includes('_serialized') && allNames.includes('ATestThatPasses'),
  'all=true brings back the used and the reflection-invoked', String(allNames.length));
ok(all.findings.find((f) => f.name === 'IsCalled').uses >= 1,
  'and reports where the used one is referenced');
ok(all.findings.find((f) => f.name === '_serialized').assetRefs.length === 1,
  'including the asset that names a serialized field');
ok(all.findings.every((f) => f.name !== 'Doomed'),
  'but not the removed one: all=true is about references, not about resurrecting history');

console.log('\nthe two renderings');
const text = renderChoreText(r);
ok(/^chore · main · last 2 commit\(s\) \w+\.\.\w+$/m.test(text),
  'the text names the branch and the exact range it read', text.split('\n')[0]);
ok(/NeverCalled/.test(text) && /add the widget/.test(text), 'and carries the finding with its commit');
const page = renderChorePage(r);
ok(/<title>chore · main<\/title>/.test(page), 'the page has a title naming the branch');
ok((page.match(/class="item/g) || []).length === r.findings.length, 'one card per finding',
  String((page.match(/class="item/g) || []).length));
ok(!/https?:\/\/(?!www\.w3\.org)/.test(page), 'and no external asset — it opens on a machine with no network');

console.log('\nan empty answer is an answer');
const empty = runChore({ repo, commits: 1 });
ok(empty.findings.length === 0 && /is unused/.test(renderChoreText(empty)),
  'the last commit added nothing unused, and the text says so rather than printing a blank');
const notRepo = runChore({ repo: tmpdir(), commits: 5 });
ok(notRepo.skipped.some((s) => /not a git repository/.test(s)) || notRepo.commits.length >= 0,
  'a directory with no history is reported, not crashed into');

rmSync(repo, { recursive: true, force: true });
console.log(fails ? `\nchore check: ${fails} FAILURE(S)\n` : '\nchore check: ok\n');
process.exit(fails ? 1 : 0);
