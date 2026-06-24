/**
 * Prompt Editor Web UI — serves on port 7773.
 * Reads/writes ~/.ayin-cli/prompts.json.
 * Ayin CLI reads from the same file on every LLM call, so edits are live.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from './log.js';
import { fixmeExecute } from './fixme.js';
import { resetPromptsToDefaults } from './prompts.js';

const PROMPTS_FILE = join(homedir(), '.ayin-cli', 'prompts.json');
const PORT = 7773;

function readPrompts(): string {
  try {
    return readFileSync(PROMPTS_FILE, 'utf-8');
  } catch {
    return '{}';
  }
}

const HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Ayin Prompts</title>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    h1 { color: #7B8CDE; margin-bottom: 20px; font-size: 1.4em; }
    .prompt { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .prompt-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .prompt-key { color: #7B8CDE; font-weight: bold; font-size: 1.1em; }
    .prompt-desc { color: #8b949e; font-size: 0.85em; margin-bottom: 8px; }
    .config-grid { display: grid; grid-template-columns: 1fr 100px; gap: 8px; align-items: center; }
    .config-label { color: #c9d1d9; font-size: 0.9em; }
    .config-input {
      background: #0d1117; color: #c9d1d9; border: 1px solid #30363d;
      border-radius: 4px; padding: 6px 10px; font-size: 14px; text-align: right;
      font-family: 'JetBrains Mono', monospace;
    }
    .config-input:focus { outline: none; border-color: #7B8CDE; }
    textarea {
      width: 100%; min-height: 200px; background: #0d1117; color: #c9d1d9;
      border: 1px solid #30363d; border-radius: 4px; padding: 10px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px;
      resize: vertical; line-height: 1.5;
    }
    textarea:focus { outline: none; border-color: #7B8CDE; }
    .actions { margin-top: 20px; display: flex; gap: 10px; align-items: center; }
    button {
      background: #7B8CDE; color: #0d1117; border: none; padding: 8px 20px;
      border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 14px;
    }
    button:hover { background: #A0ADEE; }
    .status { color: #8b949e; font-size: 0.85em; }
    .status.saved { color: #3fb950; }
    .status.error { color: #f85149; }
    .vars { color: #8b949e; font-size: 0.8em; margin-top: 4px; }
    .vars code { color: #e5c07b; background: #1c2128; padding: 1px 4px; border-radius: 2px; }
  </style>
</head>
<body>
  <h1>⬡ Ayin Prompt Editor</h1>
  <div id="prompts"></div>
  <div class="actions">
    <button onclick="save()">Save All</button>
    <span id="status" class="status"></span>
  </div>
  <script>
    let data = {};

    async function load() {
      const res = await fetch('/api/prompts');
      data = await res.json();
      render();
    }

    const CONFIG_LABELS = {
      windowSize: 'Context window (messages kept in LLM context)',
      maxToolRounds: 'Max tool rounds per user prompt',
      summaryMaxWords: 'Summary max words',
      summaryRecentMessages: 'Recent messages kept in summary',
    };

    function render() {
      const container = document.getElementById('prompts');
      container.innerHTML = '';

      // Config section
      if (data.config) {
        let configHtml = '<div class="prompt"><div class="prompt-header"><span class="prompt-key">config</span></div>';
        configHtml += '<div class="prompt-desc">Agent behavior settings (changes take effect immediately)</div>';
        configHtml += '<div class="config-grid">';
        for (const [k, v] of Object.entries(data.config)) {
          const label = CONFIG_LABELS[k] || k;
          configHtml += \`<div class="config-label">\${label}</div>\`;
          configHtml += \`<input type="number" class="config-input" value="\${v}" onchange="updateConfig('\${k}', this.value)">\`;
        }
        configHtml += '</div></div>';
        container.innerHTML += configHtml;
      }

      // Prompt sections
      for (const [key, entry] of Object.entries(data)) {
        if (key === 'config') continue;
        const vars = (entry.content.match(/\\{\\{\\w+\\}\\}/g) || []).map(v => '<code>' + v + '</code>').join(', ');
        container.innerHTML += \`
          <div class="prompt">
            <div class="prompt-header">
              <span class="prompt-key">\${key}</span>
            </div>
            <div class="prompt-desc">\${entry.description || ''}</div>
            \${vars ? '<div class="vars">Variables: ' + vars + '</div>' : ''}
            <textarea id="prompt-\${key}" oninput="updatePrompt('\${key}', this.value)">\${entry.content}</textarea>
          </div>
        \`;
      }
    }

    function updatePrompt(key, value) {
      if (data[key]) data[key].content = value;
    }

    function updateConfig(key, value) {
      if (data.config) data.config[key] = parseInt(value, 10);
    }

    async function save() {
      const status = document.getElementById('status');
      try {
        const res = await fetch('/api/prompts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (res.ok) {
          status.textContent = 'Saved ✓';
          status.className = 'status saved';
        } else {
          status.textContent = 'Save failed';
          status.className = 'status error';
        }
      } catch (e) {
        status.textContent = 'Error: ' + e.message;
        status.className = 'status error';
      }
      setTimeout(() => { status.textContent = ''; }, 3000);
    }

    load();
  </script>
</body>
</html>`;

export function startPromptServer(): void {
  const server = createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML);
      return;
    }

    if (req.url === '/api/prompts' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(readPrompts());
      return;
    }

    if (req.url === '/api/prompts' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          JSON.parse(body); // validate
          writeFileSync(PROMPTS_FILE, body, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
          log('INFO', 'prompts_saved', { size: String(body.length) });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(`{"error":"${e instanceof Error ? e.message : 'invalid json'}"}`);
        }
      });
      return;
    }

    if (req.url === '/api/fixme' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let style: string;
        try {
          style = (JSON.parse(body) as { style?: string }).style ?? '';
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"invalid json"}');
          return;
        }
        if (!style) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"style field required"}');
          return;
        }
        fixmeExecute(style).then((msg) => {
          const ok = !msg.startsWith('Error:');
          res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(ok ? { ok: true, message: msg } : { error: msg }));
          log('INFO', 'api_fixme', { style: style.slice(0, 60), ok: String(ok) });
        }).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
      });
      return;
    }

    if (req.url === '/api/reset' && req.method === 'POST') {
      try {
        resetPromptsToDefaults();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"message":"Prompts restored to defaults"}');
        log('INFO', 'api_reset', {});
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, '0.0.0.0', () => {
    log('INFO', 'prompt_server_started', { port: String(PORT) });
  });

  server.on('error', (err) => {
    log('WARN', 'prompt_server_error', { error: err.message });
  });
}
