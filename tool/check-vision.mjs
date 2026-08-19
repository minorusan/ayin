#!/usr/bin/env node
/**
 * check-vision — an image is never handed to a model that cannot see one.
 *
 * `npm run check:vision` (needs a build first). No GPU: `/api/show` reports what a blob on disk can do
 * without loading it, and the live half is skipped when no Ollama is reachable.
 *
 * WHY THIS GATE EXISTS. `read_file` on a `.png` attaches the image to the next LLM call. Sent to a
 * text-only model, that call does not come back worse — Ollama refuses it outright:
 *
 *     HTTP 400  Multimodal data provided, but model does not support multimodal requests.
 *
 * So the read succeeds, the turn dies, and what the operator sees is a transport error with no mention
 * of images. Measured against glm-4.7-flash, which is exactly the model an operator ends up on after a
 * coding session swaps the card. The capability is asked BEFORE the attach, and the failure is a
 * sentence naming the model instead.
 *
 * `null` IS NOT `false`, and the third assertion is the one that will catch a well-meaning refactor: a
 * provider that does not publish capabilities (a bare endpoint, an older runtime) must still get the
 * image. Treating "cannot tell" as "cannot see" silently disables vision everywhere except Ollama.
 */

import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = `${ROOT}dist/`;
let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

console.log('\nthe capability is declared where the other optional ones are');
{
  const prov = readFileSync(`${ROOT}src/llm/provider.ts`, 'utf-8');
  ok(/vision\?\(model\?: string\): Promise<boolean \| null>/.test(prov), 'LlmProvider.vision returns true, false OR null');
  ok(/'telemetry' \| 'events' \| 'vision'/.test(prov), "and 'vision' is a named capability, so providerHas() can ask for it");
}

console.log('\nread_file asks before it attaches');
{
  const rf = readFileSync(`${ROOT}src/tools/defs/read_file.ts`, 'utf-8');
  const askAt = rf.indexOf('provider.vision');
  // The CALL, not the import at the top of the file — which of course precedes everything.
  const attachAt = rf.indexOf('addPendingImage(img.base64)');
  ok(askAt > 0 && attachAt > 0 && askAt < attachAt, 'the capability check comes BEFORE addPendingImage');
  ok(/sees === false/.test(rf), 'and only an explicit false refuses');
  ok(!/sees !== true|!sees\b/.test(rf), "null does not refuse — an endpoint that cannot answer still gets the image");
  ok(/has no vision capability/.test(rf) && /status\.model/.test(rf),
    'the refusal NAMES the model, because "it failed" is not actionable');
  ok(!/gemma vision/.test(rf), 'and nothing here is gemma-specific any more — qwen3.x and glimmer see too');
}

console.log('\nthe live runtime, when there is one');
{
  process.env.AYIN_LLM_PROVIDER = 'ollama';
  const { llmProvider } = await import(`${DIST}llm/select.js`);
  const p = await llmProvider();
  if (p.name !== 'ollama' || !p.vision) {
    console.log('  --   no ollama provider resolved; skipping the live half');
  } else {
    const tags = await fetch('http://127.0.0.1:11434/api/tags').then((r) => r.json()).catch(() => null);
    if (!tags) {
      console.log('  --   no Ollama reachable; skipping the live half');
    } else {
      const names = (tags.models ?? []).map((m) => m.name);
      ok(await p.vision('no-such-model-here:0b') === null, 'an unknown model is null, never false');
      let sawVision = false;
      let sawBlind = false;
      for (const n of names) {
        const v = await p.vision(n);
        if (v === true) sawVision = true;
        if (v === false) sawBlind = true;
      }
      ok(sawVision || names.length === 0, `at least one pulled model reports vision (of ${names.length})`);
      // Not a requirement of the machine — just proof the answer is read, not fabricated.
      if (sawBlind) ok(true, 'and at least one reports none, so the check discriminates');
      else console.log('  --   every pulled model has vision; nothing here to discriminate against');
    }
  }
}

console.log(failures ? `\nvision check: ${failures} FAILED` : '\nvision check: ok');
process.exit(failures ? 1 : 0);
