/**
 * rename/csharp.ts — C#, and the Unity rules that make a rename here genuinely dangerous.
 *
 * In plain C# a rename is like TS: word-bounded identifiers, and the compiler catches the rest. The
 * constructor needs no special case — `class Foo { public Foo() }` names the type both times, so a
 * word-bounded scan renames it — and neither does `nameof(Foo)`, which is code.
 *
 * UNITY IS WHERE IT GETS EXPENSIVE, because two of its bindings live OUTSIDE the compiler:
 *
 *   1. **A MonoBehaviour/ScriptableObject class must match its file name.** Unity refuses to bind a
 *      component whose class name and file name differ — the inspector shows "The associated script can
 *      not be loaded", and the compiler says nothing at all. So renaming such a class REQUIRES renaming
 *      `Foo.cs` → `To.cs`, and the `.meta` beside it must move with it, CONTENTS UNTOUCHED: the GUID in
 *      that file is what every prefab and scene points at, so keeping it is what keeps the references
 *      alive. Rewriting or regenerating the meta is how a rename detaches every instance in the project.
 *
 *   2. **A serialized field's NAME is the storage key.** Every prefab, scene and asset stores the value
 *      under that name in YAML. Rename the field and Unity finds nothing under the new key, so it
 *      silently uses the default: designer-set values across the project revert to zero, with no error,
 *      often noticed weeks later. `[FormerlySerializedAs("old")]` is the supported migration and it is
 *      added automatically here — that attribute IS the rename, as far as the data is concerned.
 *
 * Also handled: verbatim (`@"..."`) and interpolated (`$"..."`) strings, where the base scanner's escape
 * rules are wrong — `@"C:\path"` has no escapes, and an interpolation hole `{Foo}` is CODE.
 */

import { basename, dirname, extname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { RenameLanguage, escapeRe, type RenameWarning } from './base.js';

const KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const',
  'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit',
  'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int',
  'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out',
  'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed',
  'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
]);

/** Unity's serialization: `public` fields and anything marked, minus what is explicitly excluded. */
const SERIALIZED_FIELD = (name: string): RegExp => new RegExp(
  `^[ \\t]*(?<attrs>(?:\\[[^\\]]*\\][ \\t]*\\r?\\n[ \\t]*)*)(?<mods>(?:public|protected|internal|private|serialized|static|readonly)[ \\t]+)*(?<type>[A-Za-z_][A-Za-z0-9_<>,\\[\\]\\.\\?]*)[ \\t]+${escapeRe(name)}[ \\t]*(?<tail>=[^;]*;|;)`,
  'm',
);

const UNITY_BASE = /:\s*(?:[A-Za-z0-9_.]*\.)?(MonoBehaviour|ScriptableObject|NetworkBehaviour|UdonSharpBehaviour)\b/;

export class CSharpRename extends RenameLanguage {
  readonly id = 'csharp';

  handles(path: string): boolean {
    return extname(path).toLowerCase() === '.cs';
  }

  validIdentifier(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }

  isReserved(name: string): boolean {
    return KEYWORDS.has(name);
  }

  declarationKind(source: string, symbol: string): string | null {
    const s = escapeRe(symbol);
    if (new RegExp(`\\b(?:class|interface|struct|enum|record)\\s+${s}\\b`).test(source)) return 'type';
    if (SERIALIZED_FIELD(symbol).test(source)) return 'field';
    if (new RegExp(`\\b${s}\\s*\\([^)]*\\)\\s*(?:=>|\\{)`).test(source)) return 'method';
    if (new RegExp(`\\b${s}\\s*\\{\\s*(?:get|set)`).test(source)) return 'property';
    return null;
  }

  /**
   * Verbatim and interpolated strings, on top of the base scanner.
   *
   * `@"..."` has no escape sequences and spans lines — treating `\` as an escape there swallows the
   * closing quote and everything after it, so the rest of the file reads as one string and a real
   * reference is silently skipped. `""` is the escaped quote inside one.
   */
  protected override spans(source: string): Array<{ from: number; to: number; kind: 'string' | 'comment' }> {
    const out: Array<{ from: number; to: number; kind: 'string' | 'comment' }> = [];
    let i = 0;
    while (i < source.length) {
      const c = source[i];
      const next = source[i + 1];
      if (c === '/' && next === '/') {
        const end = source.indexOf('\n', i);
        out.push({ from: i, to: end < 0 ? source.length : end, kind: 'comment' });
        i = end < 0 ? source.length : end;
        continue;
      }
      if (c === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        out.push({ from: i, to: end < 0 ? source.length : end + 2, kind: 'comment' });
        i = end < 0 ? source.length : end + 2;
        continue;
      }
      // `@"…""…"` — verbatim: no escapes, `""` is a literal quote, newlines allowed.
      if ((c === '@' && next === '"') || (c === '$' && next === '@' && source[i + 2] === '"')) {
        const from = i;
        i = source.indexOf('"', i) + 1;
        while (i < source.length) {
          if (source[i] === '"') {
            if (source[i + 1] === '"') { i += 2; continue; }
            i++;
            break;
          }
          i++;
        }
        out.push({ from, to: i, kind: 'string' });
        continue;
      }
      if (c === '"' || c === "'") {
        const from = i;
        i++;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === c) { i++; break; }
          if (source[i] === '\n') break;
          i++;
        }
        out.push({ from, to: i, kind: 'string' });
        continue;
      }
      i++;
    }
    return out;
  }

  consequences(path: string, before: string, after: string, symbol: string, to: string): {
    source?: string;
    fileRenames?: Array<{ from: string; to: string }>;
    warnings?: RenameWarning[];
  } {
    const warnings: RenameWarning[] = [];
    const fileRenames: Array<{ from: string; to: string }> = [];
    let rewritten: string | undefined;

    const isType = new RegExp(`\\b(?:class|interface|struct|enum|record)\\s+${escapeRe(symbol)}\\b`).test(before);
    const unityType = isType && UNITY_BASE.test(before);
    const stem = basename(path, '.cs');

    if (isType && stem === symbol) {
      const target = join(dirname(path), `${to}.cs`);
      fileRenames.push({ from: path, to: target });
      if (existsSync(`${path}.meta`)) {
        // The .meta MOVES, byte for byte. Its GUID is what every prefab and scene points at; keeping it
        // is what keeps those references attached across the rename.
        fileRenames.push({ from: `${path}.meta`, to: `${target}.meta` });
        warnings.push({
          path: `${path}.meta`,
          message: 'the .meta was moved with the file and its contents left untouched — the GUID inside it is what prefabs and scenes reference, so it must not change.',
        });
      }
      if (unityType) {
        warnings.push({
          path,
          message: `${symbol} derives from a Unity base type, so the file name is load-bearing: Unity refuses to bind a component whose class and file names differ, with no compiler error. ${basename(path)} → ${to}.cs was renamed for that reason.`,
        });
      }
    } else if (isType && unityType) {
      warnings.push({
        path,
        message: `${symbol} derives from a Unity base type but does not live in ${symbol}.cs — check that whichever file declares it is named after it, or Unity will not bind the component.`,
      });
    }

    // A serialized field's name IS the storage key. `[FormerlySerializedAs]` is the migration.
    const fieldBefore = SERIALIZED_FIELD(symbol).exec(before);
    if (fieldBefore && (!/^\s*private\b/.test(fieldBefore[0]) || /\[SerializeField\]/.test(fieldBefore[0]))) {
      const already = new RegExp(`FormerlySerializedAs\\(\\s*"${escapeRe(symbol)}"`).test(after);
      if (!already) {
        const fieldAfter = SERIALIZED_FIELD(to).exec(after);
        if (fieldAfter) {
          const indent = /^([ \t]*)/.exec(fieldAfter[0])?.[1] ?? '        ';
          const attr = `${indent}[UnityEngine.Serialization.FormerlySerializedAs("${symbol}")]\n`;
          rewritten = after.replace(fieldAfter[0], attr + fieldAfter[0]);
        }
        warnings.push({
          path,
          message: `${symbol} is a SERIALIZED field: its name is the key every prefab, scene and asset stores the value under. [FormerlySerializedAs("${symbol}")] was added — without it Unity finds nothing under the new name and silently substitutes the default, losing every value a designer set.`,
        });
      } else {
        warnings.push({ path, message: `a FormerlySerializedAs("${symbol}") is already present — left as it is.` });
      }
    }

    return { ...(rewritten ? { source: rewritten } : {}), fileRenames, warnings };
  }
}

export const csharpRename = new CSharpRename();
