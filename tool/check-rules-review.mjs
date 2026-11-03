#!/usr/bin/env node
/**
 * check-rules-review — the end-of-turn rules review, driven through the REAL loop.
 *
 * `npm run check:rules` (needs a build first). A scripted model on loopback speaks the plain HTTP
 * contract (`/api/status`, `/api/generate`); ayin runs headless in a throwaway git repo that carries a
 * `.ayin/ayin.md`. What this pins:
 *
 *   1. The rules file is first in the system message, in full.
 *   2. A turn that edited a file is answered, at the moment it would end, with the rules-review prompt
 *      naming that file — exactly once when the model then changes nothing.
 *   3. A repo with no rules file never gets the review.
 */
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'RULE-MARKER-7f3a: never write the word banana';
const REVIEW = 'Before this reaches the operator';

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const call = (name, params) => `<function=${name}>\n${Object.entries(params).map(([k, v]) => `<parameter=${k}>${v}</parameter>`).join('\n')}\n</function>`;

/** One scripted run. Returns every /api/generate request body the main loop sent. */
async function run(withRules, via = 'reply') {
  const repo = mkdtempSync(join(tmpdir(), 'ayin-rules-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  if (withRules) {
    mkdirSync(join(repo, '.ayin'));
    writeFileSync(join(repo, '.ayin', 'ayin.md'), `# Scratch rules\n\n${MARKER}\n`);
  }

  const seen = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/status') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, model: 'qwen3.8:27b-text' })); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { messages = [] } = JSON.parse(body || '{}');
      const sys = messages[0]?.role === 'system' ? messages[0].content : '';
      // The main loop's request ends on the per-round tail; sub-calls (critic, classifiers) do not.
      const main = String(messages.at(-1)?.content ?? '').includes('<session-context>');
      const all = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      let content = 'ok';
      if (main) {
        seen.push({ sys, all });
        const wrote = all.includes('<tool_response>');
        const reviewed = all.includes(REVIEW);
        if (!wrote) content = call('write_file', { path: 'notes.txt', content: 'hello\n' });
        else if (!withRules && !all.includes('Wrote notes.txt')) content = 'Wrote notes.txt with hello.';
        else if (withRules && !reviewed) content = via === 'finish' ? call('finish', { summary: 'Wrote notes.txt.' }) : 'Wrote notes.txt with hello.';
        else content = call('finish', { summary: 'Wrote notes.txt; checked against the rules: no violation.' });
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const child = spawn(process.execPath, [join(ROOT, 'dist', 'index.js'), '-p', 'Write hello into notes.txt'], {
    cwd: repo,
    env: { ...process.env, AYIN_MODEL_URL: `http://127.0.0.1:${port}`, AYIN_LLM_PROVIDER: 'direct', AYIN_MAX_ROUNDS: '12' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const code = await new Promise((r) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); r('timeout'); }, 120_000);
    child.on('exit', (c) => { clearTimeout(t); r(c); });
  });
  if (process.env.DEBUG_RULES) console.error(out.slice(-1500));
  server.close();
  return { seen, code, out, repo };
}

console.log('\nrules review — repo with .ayin/ayin.md');
const a = await run(true);
ok(a.seen.length > 0, 'the main loop reached the scripted model', `${a.seen.length} call(s), exit ${a.code}`);
ok(a.seen.every((s) => s.sys.startsWith('<rules>') && s.sys.includes(MARKER)), 'every round opens with the full rules block');
// The round counter rides after it, so count the prompt in the whole history of the last request.
const final = a.seen.at(-1)?.all ?? '';
const reviews = final.split(REVIEW).length - 1;
ok(reviews === 1, 'the review is asked exactly once when the model then changes nothing', `${reviews}`);
const at = final.indexOf(REVIEW);
ok(at >= 0 && final.slice(at, at + 400).includes('- notes.txt'), 'the review names the file that was written');
ok(/repo rules loaded — \.ayin\/ayin\.md/.test(a.out), 'startup says which rules file loaded');
// The system message carries nothing per-turn, so a new prompt cannot invalidate the cached prefix.
ok(a.seen.every((s) => s.sys === a.seen[0].sys), 'the system message is byte-identical on every round');
ok(a.seen.every((s) => !s.sys.includes('Write hello into notes.txt') && !s.sys.includes('<turn_context>')), 'and holds neither the prompt nor the turn context');
ok(/<turn_context>[\s\S]*<\/turn_context>\s*Write hello into notes\.txt/.test(a.seen[0].all), 'the turn context rides in front of the turn\'s own prompt message');

console.log('\nrules review — leaving through finish()');
const c = await run(true, 'finish');
const cFinal = c.seen.at(-1)?.all ?? '';
const cReviews = cFinal.split(REVIEW).length - 1;
ok(cReviews === 1, 'a finish() after edits is held once for the review', `${cReviews}`);
ok(/Wrote notes\.txt; checked against the rules/.test(c.out), 'and the second finish() is honoured');
// /resume rebuilds the conversation from prompt + answer records; a finish-ended turn wrote none.
{
  const { readdirSync, statSync, readFileSync: rf } = await import('node:fs');
  const { homedir } = await import('node:os');
  const dir = join(homedir(), '.ayin-cli', 'sessions');
  const rec = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n))
    .sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)
    .find((p) => rf(p, 'utf8').includes(`"cwd":${JSON.stringify(c.repo)}`));
  const kinds = rec ? rf(rec, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l).kind; } catch { return null; } }) : [];
  ok(kinds.includes('answer'), 'a finish()-ended turn records its answer, so /resume can replay it', rec ? `${kinds.filter((k) => k === 'answer').length} answer(s)` : 'no record found');
}

console.log('\nrules review — repo without rules');
const b = await run(false);
ok(b.seen.length > 0, 'the main loop reached the scripted model', `${b.seen.length} call(s), exit ${b.code}`);
ok(b.seen.every((s) => !s.all.includes(REVIEW)), 'no rules file, no review');
ok(b.seen.every((s) => !s.sys.startsWith('<rules>')), 'and no rules block');

console.log(fails ? `\nrules review check: ${fails} FAILED` : '\nrules review check: ok');
process.exit(fails ? 1 : 0);
