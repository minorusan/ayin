/**
 * PREFLIGHT — ayin refuses to open the TUI with no model configured.
 *
 * THE FIRST-RUN FAILURE THIS REPLACES. A fresh clone with nothing configured used to start the full TUI,
 * accept a prompt, and fail on the first generation with a connection error or a missing-key throw. To a
 * newcomer that reads as "ayin is broken", not "ayin needs to be told where its model is" — and the fix
 * was a `/set` command they had no reason to know existed. The check is now a gate: no model, no TUI.
 *
 * WHY IT IS A SEPARATE ENTRY POINT. `ui/screen.ts` creates the blessed screen at MODULE SCOPE, and ESM
 * evaluates every static import before any statement in the importing module — so a check written inside
 * the app can never run before blessed has taken the terminal. `dist/index.js` is therefore this file,
 * which gates and only then `await import()`s the app. Every existing invocation path (`ayin`, the bin
 * symlink, `node dist/index.js`, the vendored launcher) goes through it without changing.
 *
 * IT IS FREE WHEN CONFIGURED. The happy path reads two config keys and returns; no probe, no network, no
 * measurable delay on every launch.
 *
 * NON-INTERACTIVE NEVER PROMPTS. A `-p` run, a `watch` daemon or a CI job has nobody to answer, so an
 * unconfigured one exits with the same instructions instead of blocking forever on a read that will never
 * come. Commands that need no model at all (`version`, `update`, `--help`) skip the gate entirely —
 * refusing to tell someone their version because they have no API key would be absurd.
 */

import { createInterface } from 'node:readline/promises';
import { getConfigString, setConfigValue } from './prompts.js';
import { readOpenAiKey, writeOpenAiCredentials } from './tools/credentials/openai.js';

/** Ollama's own default. Duplicated from providers/ollama.ts deliberately: this file imports no provider. */
const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';

/** Commands that work with no model at all. */
const NO_MODEL_NEEDED = new Set(['version', '--version', '-v', 'update', 'help', '--help', '-h']);

/** True when ayin has been TOLD where a model is. Says nothing about whether one answers. */
export function hasModelConfigured(): boolean {
  const env = process.env;
  return Boolean(
    readOpenAiKey()
    || (env.AYIN_LLM_URL ?? '').trim() || getConfigString('llmUrl')
    || (env.AYIN_OLLAMA_URL ?? '').trim() || getConfigString('ollamaUrl')
    || (env.AYIN_LLM_PROVIDER ?? '').trim() || getConfigString('llmProvider'),
  );
}

export interface ModelState {
  /** Something is configured — an endpoint, an Ollama, or a key. */
  configured: boolean;
  /** A model will actually answer. This is the one the gate acts on. */
  ok: boolean;
  /** What was tried, for the operator: `AYIN_LLM_URL http://…`, `OpenAI key`, … */
  how: string;
  /** Why it failed, when it did. */
  detail: string;
}

/**
 * CONFIGURED IS NOT REACHABLE, and the gate must act on reachable.
 *
 * `AYIN_LLM_URL` exported in a shell profile made the presence check pass on a laptop whose endpoint was
 * on a LAN it was not currently on — so the TUI opened, took a prompt, and failed with a connection
 * error. That is the same first-run failure the gate exists to prevent, moved one step later. "You told
 * me where the model is" is not the guarantee worth making; "a model is there" is.
 *
 * An OpenAI key is accepted on PRESENCE alone: it was verified when `/openai` stored it, and re-verifying
 * on every launch would spend a network round trip to re-learn what is already known. A URL is probed,
 * because a URL's reachability is a property of right now, not of when it was typed.
 */
export async function checkModel(): Promise<ModelState> {
  const env = process.env;

  const key = readOpenAiKey();
  if (key) return { configured: true, ok: true, how: 'OpenAI key', detail: '' };

  const ollamaUrl = (env.AYIN_OLLAMA_URL ?? '').trim() || getConfigString('ollamaUrl') || '';
  const provider = ((env.AYIN_LLM_PROVIDER ?? '').trim() || getConfigString('llmProvider') || '').toLowerCase();
  if (ollamaUrl || provider === 'ollama') {
    const url = ollamaUrl || OLLAMA_DEFAULT;
    const p = await probeOllama(url);
    return { configured: true, ok: p.ok && p.models > 0, how: `Ollama ${url}`, detail: p.ok ? (p.models === 0 ? 'reachable, but it has no models' : '') : p.detail };
  }

  const endpoint = (env.AYIN_LLM_URL ?? '').trim() || getConfigString('llmUrl') || '';
  if (endpoint) {
    const p = await probeEndpoint(endpoint);
    const src = (env.AYIN_LLM_URL ?? '').trim() ? 'AYIN_LLM_URL' : 'llm-url';
    return { configured: true, ok: p.ok, how: `${src} ${endpoint}`, detail: p.detail };
  }

  // A provider was named but is not one that can be probed here (`direct`, `resource`) — take the
  // operator's word for it rather than blocking on a shape this file does not understand.
  if (provider) return { configured: true, ok: true, how: `llm-provider ${provider}`, detail: '' };

  return { configured: false, ok: false, how: '', detail: '' };
}

function out(s: string): void {
  process.stdout.write(s);
}

/** The whole story, in one place, so the interactive and non-interactive paths cannot drift. */
function instructions(): string {
  return [
    'ayin has no model configured, so there is nothing to answer you.',
    '',
    'Pick one:',
    '  OpenAI          ayin  →  /openai sk-…            (hosted; needs no GPU)',
    '  Local Ollama    export AYIN_LLM_PROVIDER=ollama  (or: ayin → /set llm-provider ollama)',
    '  An endpoint     export AYIN_LLM_URL=http://host:9100',
    '',
    'See SETUP.md for the full list.',
    '',
  ].join('\n');
}

/** Is this a run with nobody at the keyboard? */
function nonInteractive(): boolean {
  const argv = process.argv;
  return argv.some((a) => a === '-p' || a === '--prompt' || a === '--non-interactive')
    || argv[2] === 'watch'
    || argv[2] === 'explain'
    || !process.stdin.isTTY;
}

/** `GET {url}/api/tags` — proves an Ollama is really there, and says how many models it has. */
async function probeOllama(url: string): Promise<{ ok: boolean; models: number; detail: string }> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, models: 0, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: unknown[] };
    return { ok: true, models: body.models?.length ?? 0, detail: '' };
  } catch (err) {
    return { ok: false, models: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** `GET {url}/api/status` — the HTTP contract's own health check. */
async function probeEndpoint(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { model?: string };
    return { ok: true, detail: body.model ? `serving ${body.model}` : '' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Verify an OpenAI key the same way `/openai` does — a free call that proves authentication. */
async function probeOpenAi(key: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const { default: OpenAI } = await import('openai');
    await new OpenAI({ apiKey: key, timeout: 20_000, maxRetries: 0 }).models.list();
    return { ok: true, detail: '' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: /401/.test(msg) ? 'the key was rejected (401)' : msg.slice(0, 160) };
  }
}

/**
 * Ask until something works, or the operator quits.
 *
 * Every option is VERIFIED before it is accepted — the point of the gate is that ayin starts in a state
 * that works, and storing an unreachable URL would just move the original failure one step later.
 */
async function setupLoop(state: ModelState): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (state.configured) {
      // Configured but not answering. Name what was tried and why it failed — the operator usually knows
      // instantly ("I'm not on that network"), and a bare menu would hide the one useful fact.
      out('\n  ayin — no model is answering\n');
      out(`  Tried: ${state.how}\n`);
      if (state.detail) out(`  ${state.detail}\n`);
    } else {
      out('\n  ayin — first run\n');
      out('  No model is configured yet. This is the only thing standing between you and a working agent.\n');
    }

    // A local Ollama is the one option that can be OFFERED rather than asked for, so look once.
    const found = await probeOllama(OLLAMA_DEFAULT);
    if (found.ok) {
      out(`\n  Found an Ollama on this machine (${OLLAMA_DEFAULT}, ${found.models} model(s)).\n`);
    }

    for (;;) {
      out('\n');
      if (found.ok) out(`  1) Use that local Ollama                 [recommended — nothing leaves this machine]\n`);
      else out('  1) Local Ollama at another URL\n');
      out('  2) OpenAI API key                        [hosted; needs no GPU]\n');
      out('  3) An endpoint serving ayin\'s HTTP contract\n');
      if (state.configured) out(`  r) Retry ${state.how}\n`);
      out('  q) Quit\n');
      const choice = (await rl.question(`\n  Choose 1/2/3/${state.configured ? 'r/' : ''}q: `)).trim().toLowerCase();

      if (choice === 'q' || choice === 'quit') {
        out('\n' + instructions());
        return false;
      }

      // A backend that is merely still booting must not force the operator to reconfigure anything.
      if ((choice === 'r' || choice === 'retry') && state.configured) {
        out(`  re-checking ${state.how} … `);
        const again = await checkModel();
        if (again.ok) { out('ok.\n'); return true; }
        out(`still no.\n  ${again.detail || 'no answer'}\n`);
        continue;
      }

      if (choice === '1') {
        const url = found.ok
          ? OLLAMA_DEFAULT
          : (await rl.question(`  Ollama URL [${OLLAMA_DEFAULT}]: `)).trim() || OLLAMA_DEFAULT;
        out(`  checking ${url} … `);
        const p = await probeOllama(url);
        if (!p.ok) { out(`no.\n  ${p.detail}\n  Is Ollama running? \`ollama serve\`\n`); continue; }
        if (p.models === 0) {
          out(`reachable, but it has no models.\n  Pull one first, e.g. \`ollama pull qwen3-coder:30b\`\n`);
          continue;
        }
        setConfigValue('llmProvider', 'ollama');
        if (url !== OLLAMA_DEFAULT) setConfigValue('ollamaUrl', url);
        out(`ok (${p.models} model(s)). Saved.\n`);
        return true;
      }

      if (choice === '2') {
        const key = (await rl.question('  OpenAI key (sk-…): ')).trim();
        if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) { out('  That does not look like an OpenAI key (sk-…).\n'); continue; }
        out('  verifying with OpenAI … ');
        const p = await probeOpenAi(key);
        if (!p.ok) { out(`no.\n  ${p.detail}\n`); continue; }
        writeOpenAiCredentials({ key, model: '' });
        out('ok. Saved to ~/.ayin-cli/openai.env (0600).\n');
        out('  Note: that call is free, so it proves the key — not that the account has credit.\n');
        return true;
      }

      if (choice === '3') {
        const url = (await rl.question('  Endpoint URL (e.g. http://localhost:9100): ')).trim();
        if (!/^https?:\/\//.test(url)) { out('  Needs to be a URL starting http:// or https://\n'); continue; }
        out(`  checking ${url}/api/status … `);
        const p = await probeEndpoint(url);
        if (!p.ok) { out(`no.\n  ${p.detail}\n`); continue; }
        setConfigValue('llmUrl', url);
        out(`ok${p.detail ? ` (${p.detail})` : ''}. Saved.\n`);
        return true;
      }

      out('  Pick 1, 2, 3 or q.\n');
    }
  } finally {
    rl.close();
  }
}

/**
 * Run before anything imports the UI. Returns when ayin has a model; exits the process when it does not
 * and cannot ask. Never throws — a broken preflight must not be how someone meets this program.
 */
export async function preflight(): Promise<void> {
  try {
    if (NO_MODEL_NEEDED.has(process.argv[2] ?? '')) return;

    const state = await checkModel();
    if (state.ok) return;

    if (nonInteractive()) {
      process.stderr.write(
        state.configured
          ? `\n  ayin: no model is answering.\n  Tried: ${state.how}\n${state.detail ? `  ${state.detail}\n` : ''}\n`
          : '\n' + instructions(),
      );
      process.exit(1);
    }

    const ok = await setupLoop(state);
    if (!ok) process.exit(1);
    // Re-checked rather than trusted: the loop returns true only after a verified write, and this proves
    // the write is visible to the config reader the app will use.
    if (!hasModelConfigured()) {
      process.stderr.write('\n  Saved, but ayin still cannot see a model. Report this — it is a bug.\n');
      process.exit(1);
    }
    process.stdout.write('\n  Starting ayin…\n');
  } catch (err) {
    process.stderr.write(`\n  preflight failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(instructions());
    process.exit(1);
  }
}
