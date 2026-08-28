#!/usr/bin/env node
/**
 * check-comments — line comments on the served review page, over a REAL HTTP server.
 *
 * `npm run check:comments` (needs a build first). No LLM, no browser, no network beyond loopback; the
 * repo it reviews is built in the OS temp directory and removed again.
 *
 * WHY A SOCKET AND NOT A UNIT TEST. The whole feature is a boundary: a page fetches a route, the route
 * spawns a headless run, and that run's messages change what the next render of the same route shows.
 * Every bug this had while being written lived in that boundary and none of them were visible in the
 * pieces — the port the page must come back to, the Origin a foreign page must be refused on, the
 * status a thread holds while its run is still going, and the file on disk being newer than the HTML
 * that described it.
 *
 * ONE COMMENT, ONE RUN — and that is what makes this gate model-free in two halves.
 *
 *   The SPAWN is exercised for real, with the model made unreachable on purpose (a dead loopback port).
 *   What must hold there is not an answer but the absence of a hang: the thread goes `working` with a
 *   pid, gets its own log file, and SETTLES as failed naming that log rather than spinning forever.
 *
 *   The ANSWER is exercised by doing exactly what the run's own process does on the way out (app.ts
 *   `runHeadless`: append every message as a note, edit the file, `markDone` with the closing one).
 *   Asserting against a real model would make this gate need a GPU and stop being run.
 *
 * THE ONE THAT MATTERS MOST is the reload block: after the fix lands, the same URL must render the NEW
 * file, and the thread must still be attached and carry both the notes and the reply. A review page
 * that reloads to stale content is worse than one that never reloads, because the operator believes
 * they are looking at the result of their comment.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const DIST = new URL('../dist/', import.meta.url).pathname;

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });

const REPO = mkdtempSync(join(tmpdir(), 'ayin-comments-'));
/** The store is keyed by a hash of the repo path — a fresh temp dir is a fresh store, but be explicit. */
const storeFile = join(homedir(), '.ayin-cli', 'diffs',
  `comments-${createHash('sha1').update(REPO).digest('hex').slice(0, 12)}.jsonl`);

const logs = [];

function cleanup() {
  try { rmSync(REPO, { recursive: true, force: true }); } catch { /* nothing to do */ }
  try { rmSync(storeFile, { force: true }); } catch { /* nothing to do */ }
  for (const p of logs) { try { rmSync(p, { force: true }); } catch { /* nothing to do */ } }
}

try {
  git(REPO, 'init', '-q', '.');
  git(REPO, 'config', 'user.email', 'gate@example.invalid');
  git(REPO, 'config', 'user.name', 'gate');
  writeFileSync(join(REPO, 'C.cs'), 'public class C {\n    int x = (int)cfg.ratio;\n}\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-qm', 'base');
  writeFileSync(join(REPO, 'C.cs'), 'public class C {\n    int x = (int)cfg.ratio;\n    int y = 2;\n}\n');

  // NO MODEL IS REACHABLE FROM A RUN THIS GATE STARTS. Set before the server, because a spawned run
  // inherits this environment — a gate that quietly found a real Ollama would start editing a temp repo
  // with a model, take minutes, and pass or fail depending on the machine.
  process.env.AYIN_LLM_PROVIDER = 'direct';
  // AYIN_MODEL_URL, which is the one connection.ts reads — pointing the OTHER name at a dead port is
  // how this gate quietly ran against the operator's real endpoint for 86 seconds instead.
  process.env.AYIN_MODEL_URL = 'http://127.0.0.1:1';
  process.env.AYIN_ACQUIRE_LLM = '0';

  const { startPromptServer, serverPort, findSessionServer } = await import(`${DIST}prompt-server.js`);
  const { commentRunPrompt, runLogPath } = await import(`${DIST}diff/runner.js`);
  const { addNote, clearComments, getComment, markDone } = await import(`${DIST}diff/comments.js`);
  const { renderDiffPage } = await import(`${DIST}diff/render.js`);
  const { collectDiff } = await import(`${DIST}diff/collect.js`);

  console.log('\nthe session serves the page it will be asked about');
  startPromptServer(REPO);
  await new Promise((r) => setTimeout(r, 300));
  const port = serverPort();
  ok(port > 0, `bound a loopback port (${port})`);
  const base = `http://127.0.0.1:${port}`;
  const rec = findSessionServer(REPO);
  ok(rec !== null && rec.port === port, 'and published a record another process can find BY REPO');
  ok(findSessionServer(join(REPO, 'not-a-repo')) === null, 'which does not answer for a tree it is not serving');

  let html = await (await fetch(`${base}/diff`)).text();
  ok(html.includes('<button class="cbtn"'), 'every line carries a comment button');
  ok(/data-line="2" data-side="new"/.test(html), 'and is addressable by side AND number — a removed line is not its replacement');
  ok(html.includes('data-path="C.cs"'), 'the file knows its own path, so the client need not parse a heading');

  // NOTHING ELSE HERE RUNS THE PAGE'S JAVASCRIPT. It is a string built by a template literal, shipped
  // to a browser no gate opens, so a syntax error in it would be found by the operator clicking a
  // comment button and getting nothing at all. Parsing it costs a millisecond and closes that hole.
  const clientJs = html.split('<script>')[1]?.split('</script>')[0] ?? '';
  let parses = false;
  try { new Function(clientJs); parses = true; } catch (e) { parses = false; console.log(`       ${e.message}`); }
  ok(parses, `the page's own javascript parses (${clientJs.length} chars)`);

  console.log('\nthe endpoint that starts runs is not open to the browser at large');
  const foreign = await fetch(`${base}/api/diff/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://elsewhere.example' },
    body: JSON.stringify({ file: 'C.cs', lineNo: 2, side: 'new', text: 'x', lineText: 'y' }),
  });
  ok(foreign.status === 403, `a foreign Origin is refused (${foreign.status})`);

  const badLine = await fetch(`${base}/api/diff/comment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: 'C.cs', lineNo: '2', side: 'new', text: 'x', lineText: 'y' }),
  });
  ok(badLine.status === 400 && /lineNo/.test((await badLine.json()).error),
    'a wrongly-typed field fails loud NAMING the field, rather than being coerced');

  const emptyText = await fetch(`${base}/api/diff/comment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: 'C.cs', lineNo: 2, side: 'new', text: '   ', lineText: 'y' }),
  });
  ok(emptyText.status === 400, 'an empty comment never reaches a run');

  const badRev = await fetch(`${base}/diff?rev=${encodeURIComponent('main;rm -rf /')}`);
  ok(badRev.status === 400, 'a rev that cannot be a rev is refused at the edge');

  console.log('\nthe prompt one run receives');
  const sample = {
    id: 'c-11111111', cwd: REPO, rev: 'HEAD', file: 'C.cs', side: 'new', lineNo: 2,
    lineText: '    int x = (int)cfg.ratio;', text: 'this truncates the float',
    status: 'pending', response: '', error: '', notes: [], pid: 0,
    createdAt: new Date().toISOString(), startedAt: '', doneAt: '',
  };
  const prompt = commentRunPrompt(sample, `${base}/diff?rev=HEAD`);
  ok(prompt.startsWith(`<comment-response diffPath='${base}/diff?rev=HEAD' id="c-11111111">`),
    'it opens with the marker, the page URL and the id — the contract prompts/ayin/system.txt reads');
  ok(prompt.includes(`${REPO}/C.cs:2`) && prompt.includes('this truncates the float'),
    'and carries the ABSOLUTE path, the line and what was written');
  // THE REGRESSION THIS PINS. Handed only `file:line` and a `+`-prefixed quote of one line, a real run
  // answered "no file or specific comment was provided — I would need read_file to locate it", having
  // just named the file itself. The bytes travel in the prompt now, so there is nothing left to locate.
  ok(/int x = \(int\)cfg\.ratio;/.test(prompt) && /class C \{/.test(prompt),
    'and the FILE AROUND that line, so no round is spent finding what to edit');
  ok(/\n\s*2 > /.test(prompt), 'with the commented line marked in a number column');
  ok(prompt.includes('The numbers are NOT in the file'),
    'and the numbers disowned — the failure after "cannot find it" is a str_replace starting with "2: "');
  ok(!/^\+ /m.test(prompt),
    'nothing is diff-prefixed: a str_replace built from `+ text` matches nothing in the file');
  ok(prompt.includes(runLogPath('c-11111111')),
    'and names its own log, so a run that cannot say anything is still findable');
  ok(!/\{\{[A-Z_]+\}\}/.test(prompt), 'every {{VAR}} was substituted — a literal placeholder is a silently degraded prompt');

  console.log('\na comment is answered by its OWN run, and never leaves the thread spinning');
  const spawnPost = await fetch(`${base}/api/diff/comment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      rev: 'HEAD', file: 'C.cs', side: 'new', lineNo: 3,
      lineText: '    int y = 2;', text: 'no model is reachable, so this must fail rather than hang',
    }),
  });
  const spawned = await spawnPost.json();
  logs.push(runLogPath(spawned.id));
  ok(spawnPost.ok && /^c-[0-9a-f]{8}$/.test(spawned.id ?? ''), `accepted with an id (${spawned.id})`);
  ok(spawned.status === 'working', `and is already working when the POST returns (${spawned.status})`);
  ok(Number.isInteger(spawned.pid) && spawned.pid > 0, `a real process is answering it (pid ${spawned.pid})`);
  ok(getComment(REPO, spawned.id)?.pid === spawned.pid,
    'the pid is in the store, which is how a later boot tells a live run from a dead one');

  let settled = null;
  for (let i = 0; i < 300; i++) {
    const j = await (await fetch(`${base}/api/diff/comment/${spawned.id}`)).json();
    if (j.status === 'done' || j.status === 'failed') { settled = j; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(settled !== null, 'the thread reaches a terminal state on its own');
  ok(settled?.status === 'failed', `a run that cannot reach a model FAILS the comment (${settled?.status})`);
  ok(/comment-c-[0-9a-f]{8}\.log/.test(settled?.error ?? ''),
    `and the reason names the run's log rather than shrugging (${settled?.error})`);
  ok(existsSync(runLogPath(spawned.id)), 'which is a file that actually exists');

  console.log('\nwhat the run says arrives while it works, and the reply is the last thing it said');
  // Exactly the contract app.ts implements around `runAgent` for a run carrying AYIN_DIFF_COMMENT_ID.
  const post = await fetch(`${base}/api/diff/comment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      rev: 'HEAD', file: 'C.cs', side: 'new', lineNo: 2,
      lineText: '    int x = (int)cfg.ratio;', text: 'this truncates the float',
    }),
  });
  const created = await post.json();
  logs.push(runLogPath(created.id));
  ok(post.ok, `accepted with an id (${created.id})`);

  const REPLY = 'Dropped the (int) cast so the float survives.';
  addNote(REPO, created.id, 'Reading C.cs to see where ratio comes from.');
  const mid = await (await fetch(`${base}/api/diff/comment/${created.id}`)).json();
  ok(Array.isArray(mid.notes) && mid.notes.length === 1,
    `the page can read what the run said BEFORE it is done (${mid.notes?.length})`);
  ok(mid.notes[0].text.includes('Reading C.cs'), 'and it is what was said');
  ok(typeof mid.notes[0].at === 'string' && mid.notes[0].at.length > 0, 'stamped, so the thread has an order');

  addNote(REPO, created.id, 'The cast is the only truncation — fixing it.');
  // The hook mirrors every message, the closing one included — and stores it TRIMMED while `markDone`
  // keeps the model's own trailing newline. That difference put the same paragraph on the page twice.
  addNote(REPO, created.id, `${REPLY}\n`);
  writeFileSync(join(REPO, 'C.cs'), 'public class C {\n    float x = cfg.ratio;\n    int y = 2;\n}\n');
  markDone(REPO, created.id, REPLY);

  const done = await (await fetch(`${base}/api/diff/comment/${created.id}`)).json();
  ok(done.status === 'done', 'the thread is done');
  ok(done.response === REPLY, 'and the reply is the closing message');
  ok(done.notes.length === 3, `every note is kept (${done.notes.length}) — the poll appends only what is new`);
  ok((await fetch(`${base}/api/diff/comment/c-deadbeef`)).status === 404,
    'an unknown id is a 404 — never an empty 200 the page would read as "no news"');

  console.log('\nthe reload shows the FIX, not the page that asked for it');
  html = await (await fetch(`${base}/diff`)).text();
  ok(html.includes('float x = cfg.ratio;'), 'the same URL re-renders from the edited working tree');
  // Not "the old text is gone" — this is a DIFF, so the line the operator commented on is still on the
  // page, as a deletion. What must be true is that it appears nowhere as current code.
  const rows = [...html.matchAll(/<div class="l ([a-z]+)[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => ({ kind: m[1], body: m[2] }));
  const oldLine = rows.filter((r) => r.body.includes('int x = (int)cfg.ratio;'));
  ok(oldLine.length > 0 && oldLine.every((r) => r.kind === 'del'),
    'the commented line survives only as a DELETION — nothing still presents it as current code');
  ok(rows.some((r) => r.kind === 'add' && r.body.includes('float x = cfg.ratio;')),
    'and the replacement is on the page as an addition');
  ok(html.includes('this truncates the float'), 'the comment survives the reload');
  ok(html.includes('Dropped the (int) cast'), "and so does the run's answer");
  ok(html.includes('class="badge done"'), 'shown as done');
  ok(html.includes('class="orphan"'),
    'and because the fix moved the line, the thread is shown with its ORIGINAL coordinates rather than pinned to whatever now holds line 2');

  console.log('\nthe run\'s notes are on the page, small, and never twice');
  ok(html.includes('class="rnote"'), 'the notes render as their own rows');
  ok(html.includes('Reading C.cs to see where ratio comes from.'), 'the first thing it said is there');
  ok((html.match(/Dropped the \(int\) cast/g) || []).length === 1,
    'and the closing message appears ONCE — mirrored as a note AND stored as the reply, shown as the reply');
  ok(/\.rnote\{font:1[01]/.test(html), 'the stylesheet makes them smaller than the reply above them');
  ok(/data-n="2"/.test(html), 'the container states how many are rendered, so the poll appends only newer ones');

  console.log('\nthe red X clears every thread, and touches no code');
  const before = collectDiff(REPO, 'HEAD').files.length;
  const wiped = await fetch(`${base}/api/diff/comments`, { method: 'DELETE' });
  const wj = await wiped.json();
  ok(wiped.ok && wj.ok && wj.cleared >= 2, `the route reports what it deleted (${wj.cleared})`);
  ok(!existsSync(storeFile), 'the store file is gone, not left empty');
  html = await (await fetch(`${base}/diff`)).text();
  ok(!html.includes('this truncates the float') && !html.includes('class="rnote"'),
    'the page comes back with no comment, no note and no reply');
  ok(collectDiff(REPO, 'HEAD').files.length === before && html.includes('float x = cfg.ratio;'),
    'and the working tree is untouched — this deletes the conversation, never the work');
  ok(html.includes('id="cclear"') && /aria-label="Clear every review comment"/.test(html),
    'the FAB that does it is on the served page and labelled for a screen reader');
  ok(!renderDiffPage(collectDiff(REPO, 'HEAD')).includes('id="cclear"'),
    'and absent from a file:// page, which has no route to clear anything through');
  ok(/window\.confirm\('Clear ' \+ n/.test(html), 'it confirms before deleting, naming the count');

  console.log('\nand a thread whose line still reads the same is attached to it, not exiled');
  {
    // The orphan path above is the INTERESTING case, which is exactly why the ordinary one needs a gate
    // too: a bug that orphans every thread would still pass every assertion written so far.
    const live = collectDiff(REPO, 'HEAD');
    const stillThere = live.files.flatMap((f) => f.hunks.flatMap((h) => h.lines.map((l) => ({ f, l }))))
      .find(({ l }) => l.kind === 'add');
    const pinned = renderDiffPage(live, {
      interactive: true, rev: 'HEAD',
      comments: [{
        id: 'c-00000001', cwd: REPO, rev: 'HEAD', file: stillThere.f.path, side: 'new',
        lineNo: stillThere.l.newNo, lineText: stillThere.l.text, text: 'a comment on a line that has not moved',
        status: 'working', response: '', error: '',
        notes: [{ at: new Date().toISOString(), text: 'looking at the caller first' }], pid: 4242,
        createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), doneAt: '',
      }],
    });
    ok(pinned.includes('a comment on a line that has not moved'), 'the thread is on the page');
    ok(!pinned.includes('class="orphan"'), 'and NOT as an orphan — the anchor still holds');
    const at = pinned.indexOf('<div class="thread">');
    const rowEnd = pinned.lastIndexOf('</div>', at);
    ok(at > 0 && pinned.slice(0, rowEnd).lastIndexOf('<div class="l ') > pinned.slice(0, rowEnd).lastIndexOf('<div class="hunk"'),
      'it sits directly under a line row rather than floating in the file');
    ok(/<span class="age" data-since="\d{4}-/.test(pinned),
      'and carries a clock, so a long wait is distinguishable from a dead one');
    ok(pinned.includes('looking at the caller first'),
      'a run still working already shows what it has said — a silent five minutes looks like a dead run');
  }

  console.log('\nthe static page keeps its promise');
  const stat = renderDiffPage(collectDiff(REPO, 'HEAD'));
  ok(!stat.includes('<button class="cbtn"'), 'no comment button on a page with no session behind it');
  ok(stat.includes('comments need the session that served it'), 'and it says so, rather than offering an affordance that cannot work');
  const staticScript = stat.split('<script>')[1] ?? '';
  ok(!staticScript.includes('/api/diff/comment') && !staticScript.includes('openForm'),
    'and ships NO client for a route that is not there — the code and the affordance are absent together');
  ok(staticScript.length > 0 && staticScript.includes('apply()'),
    'while keeping the filtering the static page has always had');

  console.log(failures ? `\ncomments check: ${failures} FAILED` : '\ncomments check: ok');
} finally {
  cleanup();
}

process.exit(failures ? 1 : 0);
