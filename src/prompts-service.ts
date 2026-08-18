/**
 * PromptsService — one door to every prompt text in the installed environment.
 *
 * THE MODEL. A prompt has two homes:
 *
 *   SOURCE  — ships with the code that uses it. ayin's own prompts live in `<pkg>/prompts/ayin/`;
 *             a tool package ships `<tool>/prompts/`. Source is READ-ONLY at runtime and is never
 *             written to, so `git status` stays clean and an update can never lose an edit.
 *   LOCAL   — `~/.ayin-cli/prompts/<namespace>/<id>.txt`. The ONLY thing ever read at call time.
 *             The operator edits here; edits survive every reinstall and upgrade.
 *
 * `register(namespace, sourceDir)` materializes SOURCE → LOCAL for any id that is missing locally,
 * then hands back a `PromptBundle` bound to the LOCAL directory. **Materialization never
 * overwrites** — an id already present locally is the operator's, full stop. New ids added by a
 * later version appear on the next boot; edited ids are left alone. That is the whole upgrade story.
 *
 * WHY INJECTION. A tool package receives its bundle; it does not reach for a service singleton and
 * does not know `~/.ayin-cli` exists. So a tool depends on an interface ayin provides, not on ayin's
 * filesystem layout — which is what lets tools live in their own repo (public or private) and still
 * load prompts the same way. Without ayin a tool has no bundle and cannot run; that is intended.
 *
 * POWER CUT. Every materialized file is written to a temp path in the destination directory and
 * `rename()`d into place — atomic on POSIX. A crash mid-copy leaves either the old file or the new
 * one, never a truncated prompt. A truncated prompt is worse than a missing one: it fails silently
 * as a degraded LLM call instead of loudly as an error.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/** `~/.ayin-cli/prompts` — the local, operator-owned store. Override for tests/sandboxes. */
export const LOCAL_PROMPTS_ROOT =
  process.env.AYIN_PROMPTS_DIR || join(homedir(), '.ayin-cli', 'prompts');

/** Absolute path to a directory that ships with this package (resolved from dist/, so `..`). */
export function packagePath(...parts: string[]): string {
  const here = fileURLToPath(new URL('.', import.meta.url)); // …/dist/
  return join(here, '..', ...parts);
}

/** A namespace's prompts, resolved to the LOCAL store. This is what a tool is handed. */
export interface PromptBundle {
  /** Namespace this bundle serves (`ayin`, or a tool's unique name). */
  readonly namespace: string;
  /** The LOCAL directory these prompts are read from — `~/.ayin-cli/prompts/<namespace>`. */
  readonly dir: string;
  /** Load a prompt by id, substituting `{{VAR}}` placeholders. Throws if the id is unknown. */
  get(id: string, vars?: Record<string, string>): string;
  /** Whether an id exists locally. */
  has(id: string): boolean;
  /** Every id in this namespace. */
  ids(): string[];
}

export interface RegisterResult {
  bundle: PromptBundle;
  /** Ids copied from source into the local store on this call (first install, or a new id). */
  materialized: string[];
  /** Ids left untouched because the operator already has a local copy. */
  kept: string[];
  /** Local copies that can no longer receive the data the code passes — see `PromptDrift`. */
  drifted: PromptDrift[];
  /** Untouched local copies replaced by a newer shipped version — how a prompt FIX reaches an install. */
  refreshed: string[];
  /** Drifted copies replaced by the shipped text, with the operator's own kept beside them. */
  repaired: PromptRepair[];
}

/** A drifted prompt that was replaced, and where the operator's version was put. */
export interface PromptRepair extends PromptDrift {
  backupPath: string;
}

/**
 * A local prompt whose VARIABLE CONTRACT no longer matches the shipped one.
 *
 * This is not the same thing as an operator having edited a prompt, and conflating the two is how a
 * whole feature can ship and do nothing. Materialization never overwrites — a local file is the
 * operator's, full stop — which is right for WORDING. But `{{VAR}}` placeholders are not wording,
 * they are the interface between the code and the text: when the code starts passing
 * `{{DELIVERABLES}}` and the local copy predates that variable, the code supplies the data, the
 * prompt never asks for it, and the model is simply never told. Nothing errors. Nothing logs. The
 * feature is silently absent.
 *
 * This is exactly that bug, found by auditing rather than by noticing: a local `planDocument.txt`
 * several versions behind the shipped one meant an entire new plan section reached the model as
 * nothing at all. `restoreDefaults(ns, id)` is the fix, and it stays explicit — but the operator has
 * to be TOLD, loudly, that a prompt they are running cannot carry what the code now sends it.
 */
export interface PromptDrift {
  namespace: string;
  id: string;
  /** Declared by the shipped prompt, absent from the local one — data the model will never see. */
  missingVars: string[];
  /** In the local prompt but no longer supplied by the code — will render as a literal `{{VAR}}`. */
  staleVars: string[];
  localPath: string;
}

/** Sidecar: id → sha of the bytes we last SHIPPED for it. Absent/unreadable behaves as "unknown". */
const SHIPPED_RECORD = '.shipped.json';

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function readShippedRecord(path: string): Record<string, string> {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>; } catch { return {}; }
}

function writeShippedRecord(path: string, record: Record<string, string>): void {
  try { writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`); } catch { /* advisory only */ }
}

function varsIn(body: string): Set<string> {
  return new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
}

function readTxt(dir: string, id: string): string | null {
  const p = join(dir, `${id}.txt`);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

/**
 * Write atomically: temp file in the SAME directory (so rename never crosses a filesystem), then
 * `rename` over the target. A reader either sees the old bytes or the new ones — never a partial
 * file. The pid in the temp name keeps two concurrent ayin processes (watch daemon + TUI is the
 * normal case) from clobbering each other's in-flight write.
 */
export function writeAtomic(dest: string, body: string): void {
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, dest);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

function idsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => basename(f, '.txt'))
    .sort();
}

/**
 * Substitute `{{VAR}}` placeholders in ONE pass, with a function replacer. Both details are load-
 * bearing, and both were bugs here:
 *
 *   - **Function replacer, not a replacement string.** In a replacement string `$$`, `$&`, `` $` ``
 *     and `$'` are substitution patterns, so `$$` silently collapses to `$` and `$&` re-inserts the
 *     placeholder — the model then receives a literal `{{VAR}}`. A function's return value is
 *     inserted verbatim. Prompt vars carry file contents, tool output and user text, where `$$` is
 *     ordinary (shell, Makefiles, PHP).
 *   - **One pass, not a loop over vars.** Substituting each var in turn re-scans text already
 *     written, so a value containing `{{OTHER}}` gets expanded by a later iteration. ayin's own
 *     prompt files are full of `{{VAR}}` text — `read_file` on one, fed into a var, would inject.
 *
 * An unsupplied var is left visible rather than blanked: a `{{HOLE}}` in the output is a bug you
 * can see, an empty string is one you cannot.
 */
export function interpolate(body: string, vars: Record<string, string> = {}): string {
  return body.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  );
}

class Bundle implements PromptBundle {
  constructor(readonly namespace: string, readonly dir: string) {}

  get(id: string, vars: Record<string, string> = {}): string {
    // Read on every access — an operator editing a prompt file sees it take effect on the next
    // call, with no restart. Prompts are small and this is never in a hot loop.
    const body = readTxt(this.dir, id);
    if (body === null) {
      throw new Error(
        `prompt "${this.namespace}/${id}" not found at ${join(this.dir, `${id}.txt`)} — ` +
          `known ids: ${this.ids().join(', ') || '(none)'}`,
      );
    }
    // WYSIWYG: the file's bytes ARE the prompt, trailing newline included or omitted exactly as
    // written. No normalization on read. The alternative — strip one trailing newline so files can
    // follow the POSIX convention — was tried and reverted: it makes a prompt that must end in a
    // newline need TWO in the file, which is invisible in an editor and silently wrong when someone
    // "tidies" it. An operator editing a prompt must be able to trust that what they see is what the
    // model gets. (Cost accepted: an editor that auto-appends a final newline adds one to the prompt.
    // Harmless to a model, and visible in `git diff`, unlike the doubled-newline convention.)
    return interpolate(body, vars);
  }

  has(id: string): boolean {
    return readTxt(this.dir, id) !== null;
  }

  ids(): string[] {
    return idsIn(this.dir);
  }
}

class PromptsService {
  private readonly bundles = new Map<string, Bundle>();
  private readonly sources = new Map<string, string>();
  private readonly drift: PromptDrift[] = [];

  /**
   * Register a namespace's SOURCE directory, materialize anything missing into the LOCAL store, and
   * return the bundle bound to LOCAL. Idempotent: registering the same namespace twice re-checks for
   * newly shipped ids and returns the same bundle.
   */
  register(namespace: string, sourceDir: string): RegisterResult {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(namespace)) {
      throw new Error(`prompt namespace "${namespace}" is not a safe directory name`);
    }
    const dir = join(LOCAL_PROMPTS_ROOT, namespace);
    mkdirSync(dir, { recursive: true });

    const materialized: string[] = [];
    const kept: string[] = [];
    const drifted: PromptDrift[] = [];
    const refreshed: string[] = [];
    const repaired: PromptRepair[] = [];
    const recordPath = join(dir, SHIPPED_RECORD);
    const shippedRecord = readShippedRecord(recordPath);

    if (existsSync(sourceDir)) {
      for (const id of idsIn(sourceDir)) {
        const dest = join(dir, `${id}.txt`);
        const shipped = readFileSync(join(sourceDir, `${id}.txt`), 'utf8');
        if (existsSync(dest)) {
          let local: string | null = null;
          try { local = readFileSync(dest, 'utf8'); } catch { /* `get()` will throw loudly on first use */ }

          // A PROMPT FIX MUST BE ABLE TO REACH AN INSTALL THAT ALREADY EXISTS.
          //
          // "Never overwrite" is right for the operator's WORDING and wrong for everything else: a
          // prompt is code's interface to the model, and under that rule a shipped BUG was permanent
          // for every existing install. Measured: a protocol line whose format and explanation shared
          // a line made the model echo the explanation back as part of its command, costing an extra
          // model call per run — fixed in the repo, and still running unfixed on the machine that
          // reported it, because a local copy from an earlier version outranks the fix forever.
          //
          // The sidecar records the bytes we last SHIPPED. Local still equal to that = the operator
          // never touched it, so a newer shipped version simply replaces it. Local different = theirs,
          // and it stays theirs.
          if (local !== null && shippedRecord[id] === sha(local) && sha(shipped) !== shippedRecord[id]) {
            writeAtomic(dest, shipped);
            shippedRecord[id] = sha(shipped);
            refreshed.push(id);
            continue;
          }

          kept.push(id);
          // The variable CONTRACT is checked even though the text is not touched. Wording is the
          // operator's; placeholders are the code's interface to the text, and a local copy that
          // cannot receive what the code now passes is broken, not customised.
          if (local !== null) {
            const localVars = varsIn(local);
            const shippedVars = varsIn(shipped);
            const missingVars = [...shippedVars].filter((v) => !localVars.has(v)).sort();
            const staleVars = [...localVars].filter((v) => !shippedVars.has(v)).sort();
            if (missingVars.length || staleVars.length) {
              // BROKEN, NOT CUSTOMISED — the service's own words. The code cannot feed this text what
              // it now sends, so running it is strictly worse than running the shipped one. The
              // operator's copy is kept BESIDE it, never deleted: the edits may be worth re-applying,
              // and this is exactly the kind of file someone spent real thought on.
              const backup = `${dest}.bak-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
              try {
                writeAtomic(backup, local);
                writeAtomic(dest, shipped);
                shippedRecord[id] = sha(shipped);
                repaired.push({ namespace, id, missingVars, staleVars, localPath: dest, backupPath: backup });
                kept.pop();
                continue;
              } catch { /* could not back it up — then do NOT replace it; report the drift instead */ }
              drifted.push({ namespace, id, missingVars, staleVars, localPath: dest });
            }
          }
          continue;
        }
        writeAtomic(dest, shipped);
        shippedRecord[id] = sha(shipped);
        materialized.push(id);
      }
      this.sources.set(namespace, sourceDir);
    }

    let bundle = this.bundles.get(namespace);
    if (!bundle) {
      bundle = new Bundle(namespace, dir);
      this.bundles.set(namespace, bundle);
    }
    for (const d of drifted) this.drift.push(d);
    writeShippedRecord(recordPath, shippedRecord);
    return { bundle, materialized, kept, drifted, refreshed, repaired };
  }

  /** Every drift found since boot, for the startup warning and for `/prompts`. */
  drifts(): PromptDrift[] {
    return [...this.drift];
  }

  /** An already-registered namespace's bundle. Throws if it was never registered. */
  bundle(namespace: string): PromptBundle {
    const b = this.bundles.get(namespace);
    if (!b) {
      throw new Error(
        `prompt namespace "${namespace}" is not registered — ` +
          `registered: ${[...this.bundles.keys()].join(', ') || '(none)'}`,
      );
    }
    return b;
  }

  /** Shorthand for `bundle(ns).get(id, vars)`. */
  get(namespace: string, id: string, vars: Record<string, string> = {}): string {
    return this.bundle(namespace).get(id, vars);
  }

  /** Everything registered — for `/prompts`, the editor UI, and diagnostics. */
  list(): Array<{ namespace: string; dir: string; sourceDir: string | null; ids: string[] }> {
    return [...this.bundles.values()]
      .map((b) => ({
        namespace: b.namespace,
        dir: b.dir,
        sourceDir: this.sources.get(b.namespace) ?? null,
        ids: b.ids(),
      }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace));
  }

  /**
   * Restore one id (or a whole namespace) to what the source ships — the deliberate way to throw an
   * edit away. This is the ONLY path that overwrites a local file.
   */
  restoreDefaults(namespace: string, id?: string): string[] {
    const sourceDir = this.sources.get(namespace);
    if (!sourceDir || !existsSync(sourceDir)) {
      throw new Error(`no source directory registered for prompt namespace "${namespace}"`);
    }
    const dir = join(LOCAL_PROMPTS_ROOT, namespace);
    mkdirSync(dir, { recursive: true });

    const targets = id ? [id] : idsIn(sourceDir);
    const restored: string[] = [];
    for (const t of targets) {
      const from = join(sourceDir, `${t}.txt`);
      if (!existsSync(from)) throw new Error(`prompt "${namespace}/${t}" is not shipped by source`);
      writeAtomic(join(dir, `${t}.txt`), readFileSync(from, 'utf8'));
      restored.push(t);
    }
    return restored;
  }
}

/** The one instance. Tools never import this — they are handed a `PromptBundle`. */
export const prompts = new PromptsService();
