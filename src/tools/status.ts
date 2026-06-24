/**
 * Background task registry.
 *
 * Tracks every tool call that went background (took > BACKGROUND_TIMEOUT).
 * The agent can call the `status` tool to inspect running/completed tasks.
 */

export interface BackgroundTask {
  id: string;
  tool: string;
  paramsPreview: string;
  startTime: number;
  status: 'running' | 'completed' | 'failed';
  result?: string;
}

const tasks = new Map<string, BackgroundTask>();
let nextId = 1;

export function registerTask(tool: string, paramsPreview: string): string {
  const id = String(nextId++);
  tasks.set(id, {
    id,
    tool,
    paramsPreview,
    startTime: Date.now(),
    status: 'running',
  });
  return id;
}

export function completeTask(id: string, result: string): void {
  const task = tasks.get(id);
  if (!task) return;
  task.status = 'completed';
  task.result = result;
}

export function failTask(id: string, error: string): void {
  const task = tasks.get(id);
  if (!task) return;
  task.status = 'failed';
  task.result = error;
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

export async function statusExecute(_params: Record<string, string>): Promise<string> {
  if (tasks.size === 0) return 'No background tasks registered yet.';

  const now = Date.now();
  const lines = Array.from(tasks.values()).map(t => {
    const elapsed = formatElapsed(now - t.startTime);
    const resultPreview = t.result
      ? `\n    result: ${t.result.substring(0, 120).replace(/\n/g, ' ')}${t.result.length > 120 ? '...' : ''}`
      : '';
    return `[${t.id}] ${t.status.toUpperCase()} — ${t.tool}(${t.paramsPreview}) — ${elapsed}${resultPreview}`;
  });

  return lines.join('\n');
}
