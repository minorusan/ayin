/**
 * Artifacts — saved tool outputs, browsable via Ctrl+O overlay.
 *
 * Each tool execution saves its full output to disk.
 * The overlay lets you scroll through them with left/right arrows.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ARTIFACTS_DIR = join(homedir(), '.ayin-cli', 'artifacts');

export interface Artifact {
  id: string;
  tool: string;
  params: string;     // short description of what was called
  timestamp: number;
  filepath: string;
}

const sessionArtifacts: Artifact[] = [];

export function saveArtifact(tool: string, params: string, output: string): Artifact {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const ts = Date.now();
  const id = `${tool}-${ts}`;
  const filename = `${id}.txt`;
  const filepath = join(ARTIFACTS_DIR, filename);

  writeFileSync(filepath, output, 'utf-8');

  const artifact: Artifact = { id, tool, params, timestamp: ts, filepath };
  sessionArtifacts.push(artifact);
  return artifact;
}

export function getSessionArtifacts(): Artifact[] {
  return sessionArtifacts;
}

export function readArtifact(artifact: Artifact): string {
  try {
    return readFileSync(artifact.filepath, 'utf-8');
  } catch {
    return '(artifact file not found)';
  }
}

export function getArtifactsDir(): string {
  return ARTIFACTS_DIR;
}
