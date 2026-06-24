#!/usr/bin/env node
/**
 * ollama-adapter — a tiny, zero-dependency bridge that lets ayin talk to a local
 * Ollama server directly.
 *
 * ayin does NOT speak Ollama's native API. It speaks a small "keli-shaped" HTTP
 * contract (see docs/ARCHITECTURE.md → "LLM connection"):
 *
 *     POST /api/generate   { messages, temperature?, thinking?, images? } -> { content }
 *     GET  /api/status     -> { ok: true, model }
 *
 * This adapter implements that contract on top of Ollama's /api/chat, so you can
 * point ayin at it with KELI_URL and run fully local — no Maradel backend needed.
 *
 * Usage:
 *     OLLAMA_MODEL=qwen3-coder:30b node examples/ollama-adapter.mjs
 *     # then, in another shell:
 *     KELI_URL=http://localhost:9100 node dist/index.js -p "your task"
 *
 * Env:
 *     OLLAMA_MODEL   (required)  the Ollama model to use, e.g. qwen3-coder:30b
 *     OLLAMA_URL     default http://localhost:11434
 *     PORT           default 9100   (the port ayin's KELI_URL should point at)
 *     NUM_CTX        default 32768  context window
 */
import { createServer } from 'node:http';

const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL;
const PORT = Number(process.env.PORT ?? 9100);
const NUM_CTX = Number(process.env.NUM_CTX ?? 32768);

if (!MODEL) {
  console.error('ollama-adapter: set OLLAMA_MODEL (e.g. OLLAMA_MODEL=qwen3-coder:30b)');
  process.exit(1);
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const server = createServer(async (req, res) => {
  try {
    // Health/identity — ayin reads {model} from here to pick its dialect (gemma vs qwen).
    if (req.method === 'GET' && req.url?.startsWith('/api/status')) {
      return json(res, 200, { ok: true, model: MODEL });
    }

    if (req.method === 'POST' && req.url?.startsWith('/api/generate')) {
      const body = JSON.parse((await readBody(req)) || '{}');
      const messages = Array.isArray(body.messages) ? body.messages : [];
      // ayin sends images as a top-level array; Ollama wants them on a message.
      if (Array.isArray(body.images) && body.images.length && messages.length) {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        if (lastUser) lastUser.images = body.images;
      }
      const r = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages,
          stream: false,
          think: Boolean(body.thinking),
          options: { temperature: typeof body.temperature === 'number' ? body.temperature : 0.7, num_ctx: NUM_CTX },
        }),
      });
      if (!r.ok) return json(res, 502, { error: `ollama ${r.status}: ${await r.text()}` });
      const data = await r.json();
      return json(res, 200, { content: data?.message?.content ?? '', reasoning: data?.message?.thinking ?? '' });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`ollama-adapter → ${OLLAMA_URL} (model: ${MODEL}) listening on http://localhost:${PORT}`);
  console.log(`point ayin at it:  KELI_URL=http://localhost:${PORT} node dist/index.js -p "..."`);
});
