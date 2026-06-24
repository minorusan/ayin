/**
 * Codex tool — spawns an OpenAI Codex agent for deep research.
 *
 * The agent is told to investigate the query, write findings to a temp file,
 * and exit. The file is read and returned as the tool result.
 *
 * Uses OPENAI_API_KEY from ~/.egregor/config.env.
 * Codex runs with --dangerously-bypass-approvals-and-sandbox (same as kahili).
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from './log.js';
import { getConfigString } from './prompts.js';

// ── Env loader (same as jira.ts) ─────────────────────────────────────

function loadEgregorEnv(): Record<string, string> {
  const envPath = `${process.env.HOME ?? '/home/erkamen'}/.egregor/config.env`;
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

// ── Main execute ──────────────────────────────────────────────────

export async function codexExecute(params: Record<string, string>): Promise<string> {
  const query = params.query?.trim();
  if (!query) return 'Error: query parameter required';

  const env = loadEgregorEnv();
  // Key lookup order: env var → ~/.ayin-cli/prompts.json config → ~/.egregor/config.env
  const apiKey = process.env.OPENAI_API_KEY
    || getConfigString('openAiKey')
    || env.OPENAI_API_KEY;
  if (!apiKey) {
    return 'Error: OpenAI API key not configured. Run: /set openai-key sk-...';
  }

  const cwd = params.cwd || process.cwd();
  const reportFile = join(tmpdir(), `ayin-codex-${Date.now()}.md`);

  // Write placeholder so codex can overwrite it
  writeFileSync(reportFile, '');

  const prompt = `You are a research agent. Your task:

${query}

MANDATORY: Write your complete findings to this file: ${reportFile}
- Write to it immediately when you start ("# Research: <topic>\\nInvestigating...")
- Update it as you progress
- Replace the entire contents with your final report when done

Your final report should be in markdown with clear headings, specific findings, code examples where relevant, and actionable conclusions. Be thorough but concise.

Do NOT ask for clarification. Research and write the report.`;

  log('INFO', 'codex_start', { query: query.slice(0, 100), cwd, reportFile });

  return new Promise<string>((resolve) => {
    const child = spawn(
      'codex',
      [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '-C', cwd,
        prompt,
      ],
      {
        cwd,
        stdio: 'pipe',
        env: { ...process.env, OPENAI_API_KEY: apiKey },
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));

    // Removed timeout guard - codex will run until completion
    child.on('exit', (code) => {
      log('INFO', 'codex_exit', { code: String(code), query: query.slice(0, 60) });

      const report = readReportFile(reportFile);
      try { unlinkSync(reportFile); } catch { /* already gone */ }

      if (report.trim()) {
        resolve(report);
        return;
      }

      // No report file written — fall back to stdout
      const stdout = Buffer.concat(stdoutChunks).toString().trim();
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      if (stdout) {
        resolve(`(codex wrote no report file — stdout output):\n\n${stdout}`);
      } else if (stderr) {
        resolve(`Codex error (exit ${code}):\n${stderr.slice(0, 1000)}`);
      } else {
        resolve(`Codex exited (code ${code}) with no output.`);
      }
    });

    child.on('error', (err) => {
      resolve(`Failed to spawn codex: ${err.message}`);
    });
  });
}

function readReportFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return '';
  }
}