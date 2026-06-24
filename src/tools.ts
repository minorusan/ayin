/**
 * Tools — definitions for the LLM system prompt + execution.
 *
 * Each tool has:
 *   - XML definition (for the system prompt, Qwen3 Coder format)
 *   - execute() function that runs it and returns string output
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, basename, resolve, join, isAbsolute, extname } from 'node:path';
import { homedir } from 'node:os';
import { isImagePath, preprocessImage, addPendingImage } from './image.js';
import { getPrompt } from './prompts.js';
import { jiraExecute } from './jira.js';
import { codexExecute } from './codex.js';
import { fixmeExecute } from './fixme.js';
import { statusExecute } from './tools/status.js';
import { exploreExecute } from './tools/explore.js';
import { docsSearchExecute } from './tools/docs-search.js';

// ── Async exec ──────────────────────────────────────────────────────

let activeToolCancel: (() => void) | null = null;

function terminateChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch {}
  }
}

export function cancelActiveToolExecution(): boolean {
  if (!activeToolCancel) return false;
  activeToolCancel();
  activeToolCancel = null;
  return true;
}

function execAsync(command: string, opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: opts.cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (activeToolCancel === cancel) activeToolCancel = null;
      fn();
    };

    const cancel = (): void => {
      cancelled = true;
      terminateChild(child.pid, 'SIGTERM');
      setTimeout(() => terminateChild(child.pid, 'SIGKILL'), 1500);
    };
    activeToolCancel = cancel;

    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      finish(() => reject(error));
    });

    child.on('close', (code) => {
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();

      if (cancelled) {
        finish(() => reject(new Error('Command cancelled.')));
        return;
      }

      finish(() => {
        if (out) resolve(out);
        else if (code && code !== 0) resolve(`Command exited with code ${code}`);
        else resolve('(no output)');
      });
    });
  });
}

// ── Path suggestions (for "file not found" hints) ──────────────────
//
// When a path-taking tool (read_file, grep, find_files) can't find its
// target, suggest the closest existing sibling so the model can
// self-correct on the next round instead of spinning on typo variants.
// Triggered primarily by gemma4, which mistypes proper nouns in paths
// (e.g. `PickMinigame` ↔ `PickMinagame`).

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  const curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = [...curr];
  }
  return prev[n];
}

/** Resolve `path` against CWD if it isn't already absolute. */
function resolveAgainstCwd(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** For a missing path, suggest up to 3 closest existing entries at the
 *  deepest existing ancestor — comparing against the *first missing*
 *  path segment (e.g. for `Assets/Scripts/PickMinagame/Foo.cs` when only
 *  `Assets/Scripts` exists, the first missing segment is `PickMinagame`).
 *  This catches both pure-filename typos and directory-name typos.
 *  Returns "" when no good matches. */
function suggestSimilarPaths(missing: string, maxSuggestions = 3): string {
  const target = resolveAgainstCwd(missing);

  // Walk up to the deepest existing ancestor; remember the first missing segment.
  let ancestor = target;
  let firstMissing = basename(target);
  let depth = 0;
  while (depth < 20 && ancestor !== '/' && ancestor !== '.' && !existsSync(ancestor)) {
    firstMissing = basename(ancestor);
    ancestor = dirname(ancestor);
    depth++;
  }
  if (!existsSync(ancestor) || !firstMissing) return '';

  const wanted = firstMissing.toLowerCase();

  let entries: string[];
  try {
    entries = readdirSync(ancestor, { withFileTypes: true })
      .filter(e => e.isFile() || e.isDirectory())
      .map(e => e.name);
  } catch {
    return '';
  }
  if (entries.length === 0) return '';

  // Accept matches within ~1/3 of the wanted length — catches common
  // single-character typos (PickMinigame ↔ PickMinagame) without flooding.
  const threshold = Math.max(2, Math.floor(wanted.length / 3));

  const ranked = entries
    .map(name => ({ name, d: levenshtein(name.toLowerCase(), wanted) }))
    .filter(x => x.d <= threshold && x.d > 0)
    .sort((a, b) => a.d - b.d)
    .slice(0, maxSuggestions);

  if (ranked.length === 0) return '';

  const suggestions = ranked.map(r => join(ancestor, r.name)).join(', ');
  return ` Did you mean: ${suggestions}?`;
}

// ── Tool interface ──────────────────────────────────────────────────

export interface Tool {
  name: string;
  description: string;
  parameters: Array<{ name: string; type: string; description: string; required?: boolean }>;
  execute(params: Record<string, string>): Promise<string>;
}

type DiffOp =
  | { type: 'equal'; line: string }
  | { type: 'delete'; line: string }
  | { type: 'insert'; line: string };

function buildLineDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'equal', line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: 'insert', line: newLines[j] });
      j++;
    }
  }

  while (i < rows) ops.push({ type: 'delete', line: oldLines[i++] });
  while (j < cols) ops.push({ type: 'insert', line: newLines[j++] });
  return ops;
}

function buildUnifiedDiff(path: string, before: string, after: string, contextLines = 3): string {
  if (before === after) return `File: ${path}\n(no changes)`;

  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const ops = buildLineDiff(oldLines, newLines);

  const changeIndexes: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type !== 'equal') changeIndexes.push(idx);
  }

  const hunks: Array<{ start: number; end: number }> = [];
  for (const idx of changeIndexes) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(ops.length, idx + contextLines + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
  }

  const out: string[] = [`File: ${path}`, `--- ${path}`, `+++ ${path}`];

  for (const hunk of hunks) {
    let oldLineNo = 1;
    let newLineNo = 1;
    for (let idx = 0; idx < hunk.start; idx++) {
      const op = ops[idx];
      if (op.type !== 'insert') oldLineNo++;
      if (op.type !== 'delete') newLineNo++;
    }

    const hunkOps = ops.slice(hunk.start, hunk.end);
    const oldCount = hunkOps.filter(op => op.type !== 'insert').length;
    const newCount = hunkOps.filter(op => op.type !== 'delete').length;
    out.push(`@@ -${oldLineNo},${oldCount} +${newLineNo},${newCount} @@`);

    for (const op of hunkOps) {
      if (op.type === 'equal') out.push(` ${op.line}`);
      else if (op.type === 'delete') out.push(`-${op.line}`);
      else out.push(`+${op.line}`);
    }
  }

  return out.join('\n');
}

// ── Tool implementations ────────────────────────────────────────────

const CWD = process.cwd();
const PROMPTS_FILE = `${homedir()}/.ayin-cli/prompts.json`;

const tools: Tool[] = [
  {
    name: 'bash',
    description: 'Execute a shell command and return its output. Use for: running scripts, installing packages, git commands, listing files, checking system state.',
    parameters: [
      { name: 'command', type: 'string', description: 'The shell command to execute', required: true },
    ],
    async execute(params) {
      if (!params.command) return 'Error: command required';
      return execAsync(params.command, { cwd: CWD });
    },
  },
  {
    name: 'read_file',
    description: 'Read a file and return its contents with line numbers. Use offset/limit for large files. For image files (png/jpg/jpeg/webp/gif/avif/tiff/bmp) the image is downscaled and attached to the next LLM call for vision processing instead of returning bytes.',
    parameters: [
      { name: 'path', type: 'string', description: 'Absolute file path', required: true },
      { name: 'offset', type: 'number', description: 'Starting line number (0-based, text only)', required: false },
      { name: 'limit', type: 'number', description: 'Max lines to return (text only)', required: false },
    ],
    async execute(params) {
      if (!params.path) return 'Error: path required';
      const resolved = resolveAgainstCwd(params.path);
      if (!existsSync(resolved)) {
        return `Error: file not found: ${params.path}.${suggestSimilarPaths(params.path)}`;
      }
      const ext = extname(resolved).toLowerCase();
      if (ext === '.pdf') {
        return `Error: PDFs are not natively supported by gemma vision. Rasterize to PNG first, e.g.:\n  pdftoppm -r 200 -png "${resolved}" /tmp/page\n  read_file /tmp/page-1.png`;
      }
      if (isImagePath(resolved)) {
        try {
          const img = await preprocessImage(resolved);
          addPendingImage(img.base64);
          const kb = (img.outBytes / 1024).toFixed(1);
          return `[attached image: ${basename(resolved)}, ${img.origDims}→${img.outDims}, ${kb}KB ${img.format}]`;
        } catch (e) {
          return `Error: failed to read image ${params.path}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const content = readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      const off = parseInt(params.offset || '0', 10);
      const lim = parseInt(params.limit || String(lines.length), 10);
      const slice = lines.slice(off, off + lim);
      const numbered = slice.map((l, i) => `${off + i + 1}\t${l}`).join('\n');
      const header = lines.length > lim + off ? `(lines ${off + 1}-${off + slice.length} of ${lines.length})\n` : '';
      return `${header}${numbered}`;
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed. Use for creating new files or completely rewriting existing ones.',
    parameters: [
      { name: 'path', type: 'string', description: 'Absolute file path', required: true },
      { name: 'content', type: 'string', description: 'Complete file content to write', required: true },
    ],
    async execute(params) {
      if (!params.path || params.content === undefined) return 'Error: path and content required';
      if (params.path === PROMPTS_FILE) {
        try {
          JSON.parse(params.content);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `Error: refusing to write invalid JSON to ${PROMPTS_FILE}: ${message}`;
        }
      }
      const before = existsSync(params.path) ? readFileSync(params.path, 'utf-8') : '';
      mkdirSync(dirname(params.path), { recursive: true });
      writeFileSync(params.path, params.content, 'utf-8');
      return buildUnifiedDiff(params.path, before, params.content);
    },
  },
  {
    name: 'str_replace',
    description:
      'Make a SURGICAL edit to an existing file: replace ONE exact, unique block of text with new text. ' +
      'PREFER THIS over write_file for editing existing files — it changes only the targeted lines and cannot ' +
      'drop or truncate the rest of the file. `old_str` must match the current file EXACTLY (including whitespace ' +
      'and indentation) and occur EXACTLY ONCE — include a few surrounding lines to make it unique. To insert code, ' +
      'set `new_str` to the matched block plus your addition. Returns a unified diff.',
    parameters: [
      { name: 'path', type: 'string', description: 'Absolute file path', required: true },
      { name: 'old_str', type: 'string', description: 'Exact existing text to replace (must be unique in the file)', required: true },
      { name: 'new_str', type: 'string', description: 'Replacement text', required: true },
    ],
    async execute(params) {
      if (!params.path || params.old_str === undefined || params.new_str === undefined) {
        return 'Error: path, old_str and new_str required';
      }
      const resolved = resolveAgainstCwd(params.path);
      if (!existsSync(resolved)) return `Error: file not found: ${params.path}.${suggestSimilarPaths(params.path)}`;
      if (params.old_str === params.new_str) return 'Error: old_str and new_str are identical — nothing to change.';
      const before = readFileSync(resolved, 'utf-8');
      const count = before.split(params.old_str).length - 1;
      if (count === 0) return `Error: old_str not found in ${params.path}. read_file it and copy the exact text (including indentation).`;
      if (count > 1) return `Error: old_str occurs ${count} times in ${params.path} — include more surrounding lines to make it unique.`;
      const after = before.replace(params.old_str, params.new_str);
      writeFileSync(resolved, after, 'utf-8');
      return buildUnifiedDiff(params.path, before, after);
    },
  },
  {
    name: 'grep',
    description: 'Search file contents using grep. Returns matching lines with file paths and line numbers.',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Search pattern (regex)', required: true },
      { name: 'path', type: 'string', description: 'Directory or file to search', required: true },
      { name: 'include', type: 'string', description: 'File glob filter, e.g. "*.ts"', required: false },
    ],
    async execute(params) {
      if (!params.pattern || !params.path) return 'Error: pattern and path required';
      if (!existsSync(resolveAgainstCwd(params.path))) {
        return `Error: path not found: ${params.path}.${suggestSimilarPaths(params.path)}`;
      }
      const inc = params.include ? ` --include="${params.include}"` : '';
      return execAsync(`grep -rn "${params.pattern}" "${params.path}"${inc} | head -50`, { cwd: CWD });
    },
  },
  {
    name: 'find_files',
    description: 'Find files by name pattern. Returns list of matching file paths.',
    parameters: [
      { name: 'path', type: 'string', description: 'Directory to search in', required: true },
      { name: 'pattern', type: 'string', description: 'File name glob, e.g. "*.ts" or "package.json"', required: true },
    ],
    async execute(params) {
      if (!params.path || !params.pattern) return 'Error: path and pattern required';
      if (!existsSync(resolveAgainstCwd(params.path))) {
        return `Error: path not found: ${params.path}.${suggestSimilarPaths(params.path)}`;
      }
      return execAsync(`find "${params.path}" -name "${params.pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" | head -30`, { cwd: CWD });
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for documentation, APIs, tutorials, error messages, or any information not available locally. Returns a synthesized answer with sources.',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
    ],
    async execute(params) {
      if (!params.query) return 'Error: query required';
      return execAsync(
        `malkhut search -query "${params.query.replace(/"/g, '\\"')}" --reasoning`,
        { cwd: CWD },
      );
    },
  },
  {
    name: 'fixme',
    description: 'Rewrite the agent\'s personality/voice to match a user-requested style. The user says something like "talk like Yoda" or "respond like a pirate" — call this tool with that style description. It rewrites the system prompts via OpenAI and takes effect immediately. Use /reset to undo.',
    parameters: [
      { name: 'style', type: 'string', description: 'The personality or voice style to apply, e.g. "Master Yoda", "sarcastic British butler", "40 year old street hustler"', required: true },
    ],
    async execute(params) {
      if (!params.style) return 'Error: style parameter required';
      return fixmeExecute(params.style);
    },
  },
  {
    name: 'codex',
    description: 'Spawn an OpenAI Codex agent to deeply research a hard problem. Use for complex questions that require reading many files, tracing logic across a codebase, or synthesizing information into a report. The agent runs autonomously and returns a markdown report when done. This takes 1-5 minutes — use only when the question is genuinely hard.',
    parameters: [
      { name: 'query', type: 'string', description: 'The research question or task for the codex agent. Be specific — include file paths, function names, or error messages if relevant.', required: true },
      { name: 'cwd', type: 'string', description: 'Working directory for the agent (default: current directory)', required: false },
      { name: 'timeout', type: 'number', description: 'Timeout in ms (default: 300000 = 5 min)', required: false },
    ],
    async execute(params) {
      return codexExecute(params);
    },
  },
  {
    name: 'jira',
    description: 'Query Jira using JQL (Jira Query Language). Use for: finding tickets, checking sprint status, listing issues by assignee/project/status, getting issue counts. Returns formatted issue list.',
    parameters: [
      { name: 'jql', type: 'string', description: 'JQL query string, e.g. "project = PP AND status = \"In Progress\" AND assignee = currentUser()"', required: true },
      { name: 'maxResults', type: 'number', description: 'Max issues to return (default 20, max 50)', required: false },
      { name: 'fields', type: 'string', description: 'Comma-separated field names to include (default: summary, status, assignee, priority, issuetype, updated, comment, labels)', required: false },
    ],
    async execute(params) {
      return jiraExecute(params);
    },
  },
  {
    name: 'explore',
    description: 'Find and read code in the codebase. Spawns a sub-agent that iteratively runs read-only commands (ls, cat, grep, git show/log/blame, find) to locate files and extract content. Use this when you need to find an unknown file, read a method body, find where a field is assigned, list callers, or run git log. Returns extracted code/data as text. NOTE: explore only FINDS and READS — it does not reason or explain. Ask it factual questions like "find X" or "show Y", not "why does X happen".',
    parameters: [
      { name: 'question', type: 'string', description: 'A factual question asking explore to FIND or READ something. Good: "Find ClassName.cs and show MethodName body", "Find where _field is set to null", "Run git log on path/file.cs". Bad: "Why does X happen", "What triggers the error".', required: true },
      { name: 'context', type: 'string', description: 'Optional extra context — file paths, class names, error messages, stack frames', required: false },
    ],
    async execute(params) {
      return exploreExecute(params);
    },
  },
  {
    name: 'status',
    description: 'Check the status of background tool tasks. Shows all tasks that went background (took >20s), their current status (running/completed/failed), how long they have been running, and a preview of their result once done. Call this to check on long-running tools like codex or web_search.',
    parameters: [],
    async execute(params) {
      return statusExecute(params);
    },
  },
  {
    name: 'docs_search',
    description:
      "Semantic search over MARADEL'S OWN documentation (CLAUDE.md rules + docs/*.md: ARCHITECTURE, MEMORY, " +
      'PROTOCOL, HABITS, TOOLS, CONNECTORS, TechDebt, etc.). Use this FIRST when working in the Maradel repo and ' +
      'you need a concept, rule, architecture detail, protocol contract, or known tech-debt item — it understands ' +
      'meaning, so you do not need exact keywords. Returns the most relevant doc sections with file + heading ' +
      'citations. Prefer this over grepping docs or reading whole doc files. For CODE (not docs) use grep/explore.',
    parameters: [
      { name: 'query', type: 'string', description: 'What you want to know, in natural language (e.g. "how are tool names kept unique", "rule for shipping an app release")', required: true },
      { name: 'k', type: 'number', description: 'Max sections to return (default 6, max 20)', required: false },
    ],
    async execute(params) {
      return docsSearchExecute(params);
    },
  },
];

// ── Tool registry ───────────────────────────────────────────────────

const toolMap = new Map<string, Tool>();
for (const t of tools) toolMap.set(t.name, t);

export function getTool(name: string): Tool | undefined {
  return toolMap.get(name);
}

export function getAllTools(): Tool[] {
  return tools;
}

// ── System prompt XML ───────────────────────────────────────────────

export function toolsSystemPrompt(): string {
  const toolDefs = tools.map(t => {
    const params = t.parameters
      .map(p => `  - ${p.name} (${p.type}${p.required === false ? ', optional' : ''}): ${p.description}`)
      .join('\n');
    return `${t.name}: ${t.description}\n  Parameters:\n${params}`;
  }).join('\n\n');

  return getPrompt('system', {
    WORKING_DIR: CWD,
    TOOLS: toolDefs,
  });
}
