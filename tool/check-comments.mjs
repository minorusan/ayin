#!/usr/bin/env node
/**
 * check-comments — line comments on the served review page, over a REAL HTTP server.
 *
 * `npm run check:comments` (needs a build first). No LLM, no browser, no network beyond loopback; the
 * repo it reviews is built in the OS temp directory and removed again.
 *
 * WHY A SOCKET AND NOT A UNIT TEST. The whole feature is a boundary: a page fetches a route, a route
 * starts an agent turn, the turn's end changes what the next render of that same route shows. Every bug
 * this had while being written lived in that boundary and none of them were visible in the pieces —
 * the port the page must come back to, the Origin a foreign page must be refused on, the status a
 * comment holds while a turn it was folded into is still running, and the file on disk being newer
 * than the HTML that described it.
 *
 * THE AGENT IS A STUB, deliberately. It marks the comment working, edits the file, and finishes with a
 * sentence — which is exactly the contract app.ts implements around `runAgent`. Asserting against a real
 * model would make this gate need a GPU and stop being run.
 *
 * THE ONE THAT MATTERS MOST is the last block: after the stub "fixes" the code, the same URL must render
 * the NEW file, and the thread must still be attached and carry the reply. A review page that reloads to
 * stale content is worse than one that never reloads, because the operator believes they are looking at
 * the result of their comment.
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

function cleanup() {
  try { rmSync(REPO, { recursive: true, force: true }); } catch { /* nothing to do */ }
  try { rmSync(storeFile, { force: true }); } catch { /* nothing to do */ }
}

try {
  git(REPO, 'init', '-q', '.');
  git(REPO, 'config', 'user.email', 'gate@example.invalid');
  git(REPO, 'config', 'user.name', 'gate');
  writeFileSync(join(REPO, 'C.cs'), 'public class C {\n    int x = (int)cfg.ratio;\n}\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-qm', 'base');
  writeFileSync(join(REPO, 'C.cs'), 'public class C {\n    int x = (int)cfg.ratio;\n    int y = 2;\n}\n');

  const { startPromptServer, serverPort, findSessionServer } = await import(`${DIST}prompt-server.js`);
  const { wireDiffComments } = await import(`${DIST}diff/server.js`);
  const { markWorking, markDone, commentIdFromPrompt } = await import(`${DIST}diff/comments.js`);
  const { renderDiffPage } = await import(`${DIST}diff/render.js`);
  const { collectDiff } = await import(`${DIST}diff/collect.js`);

  let seenPrompt = '';
  wireDiffComments((id, prompt) => {
    seenPrompt = prompt;
    markWorking(REPO, id);
    setTimeout(() => {
      writeFileSync(join(REPO, 'C.cs'), 'public class C {\n    float x = cfg.ratio;\n    int y = 2;\n}\n');
      markDone(REPO, id, 'Dropped the (int) cast so the float survives.');
    }, 300);
  });

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

  console.log('\nthe endpoint that starts agent turns is not open to the browser at large');
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
  ok(emptyText.status === 400, 'an empty comment never reaches the agent');

  const badRev = await fetch(`${base}/diff?rev=${encodeURIComponent('main;rm -rf /')}`);
  ok(badRev.status === 400, 'a rev that cannot be a rev is refused at the edge');

  console.log('\npending → working → done, and the page can see each step');
  const post = await fetch(`${base}/api/diff/comment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      rev: 'HEAD', file: 'C.cs', side: 'new', lineNo: 2,
      lineText: '    int x = (int)cfg.ratio;', text: 'this truncates the float',
    }),
  });
  const created = await post.json();
  ok(post.ok && /^c-[0-9a-f]{8}$/.test(created.id ?? ''), `accepted with an id (${created.id})`);
  ok(created.status === 'pending', 'and is pending until something takes it up');
  ok(seenPrompt.startsWith(`<comment-response diffPath='${base}/diff?rev=HEAD' id="${created.id}">`),
    'the agent gets the marker, the page URL and the id — the contract prompts/ayin/system.txt reads');
  ok(seenPrompt.includes('C.cs:2') && seenPrompt.includes('this truncates the float'),
    'and the file, the line and what was written');
  ok(commentIdFromPrompt(seenPrompt) === created.id,
    'the id survives the round trip through prompt text — how a comment folded into a running turn is found again');

  const seen = [];
  let reply = '';
  for (let i = 0; i < 40; i++) {
    const j = await (await fetch(`${base}/api/diff/comment/${created.id}`)).json();
    if (seen[seen.length - 1] !== j.status) seen.push(j.status);
    if (j.status === 'done') { reply = j.response; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(seen.includes('working'), `the page is told when a turn picks the comment up (${seen.join(' → ')})`);
  ok(seen[seen.length - 1] === 'done', 'and when that turn ends');
  ok(reply.includes('Dropped the (int) cast'), `the reply comes back to the page (${JSON.stringify(reply)})`);
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
  ok(html.includes('Dropped the (int) cast'), "and so does the agent's answer");
  ok(html.includes('class="badge done"'), 'shown as done');
  ok(html.includes('class="orphan"'),
    'and because the fix moved the line, the thread is shown with its ORIGINAL coordinates rather than pinned to whatever now holds line 2');

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
