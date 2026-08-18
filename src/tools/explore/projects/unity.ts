/**
 * Unity — where the glue is a hash, not a name.
 *
 * A C# class becomes part of a Unity game by being REFERENCED FROM AN ASSET, and that reference is
 * not the class name. Every file has a sibling `.meta` holding a GUID, and `.prefab`, `.unity`,
 * `.asset` and `.anim` files point at scripts by that GUID. So:
 *
 *     "which prefabs use ScoreService?"   is NOT a text search for ScoreService
 *
 * It is: read `ScoreService.cs.meta` → take the guid → search assets for the guid. Two steps, both
 * deterministic, and a grep for the class name answers none of it. This is the single strongest
 * reason a Unity-aware explorer beats a generic one.
 *
 * FOUR ASSET FAMILIES, and the last two are the ones usually missed:
 *   .prefab / .unity — object wiring, the obvious ones
 *   .asset           — ScriptableObjects. Most CONFIGURATION lives here, so this is where a designer
 *                      changes behaviour without touching code. Searching only prefabs misses it.
 *   .anim            — animation clips. These reference methods BY NAME STRING in animation events,
 *                      and property paths as strings. Rename the method and nothing fails to
 *                      compile; the event simply stops firing at runtime. No compiler, no linker and
 *                      no import graph sees this edge — only a string search of the clip does.
 *
 * ASSEMBLY DEFINITIONS bound what can even reference what. A symbol in an asmdef that does not
 * reference yours is not a candidate no matter how well the name matches, so the enclosing asmdef is
 * reported as a fact about every hit.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Finding, ProjectExplorer, Reason } from '../types.js';
import { PRUNE, runProbe, parseGrepLine } from '../search.js';

/**
 * THE TERM IS OFTEN A SUFFIX, NOT THE WHOLE NAME.
 *
 * "where is the time bonus calculated" yields the term `TimeBonus`, but the method is
 * `GetTimeBonus()`. `\bTimeBonus` cannot match it: both `t` and `T` are word characters, so there is
 * no word boundary inside `GetTimeBonus`, and the declaration is unreachable no matter how many
 * probes run. Measured on the real repository: explore found the CALL SITE of the time bonus and
 * never its definition — one hop short of the defect, which lived in the method body.
 *
 * Code names things with accessor and verb prefixes. Allowing that set (and the `_private`
 * convention already handled) is what makes a suffix term find its declaration.
 */
const PREFIX = '(?:_|get|set|on|handle|try|compute|calculate|apply|update|add|remove|is|has|do|make|build|create|fetch|read|write|find|resolve|Get|Set|On|Handle|Try|Compute|Calculate|Apply|Update|Add|Remove|Is|Has|Do|Make|Build|Create|Fetch|Read|Write|Find|Resolve)?';

const ASSET_GLOBS = ['*.prefab', '*.unity', '*.asset', '*.anim', '*.controller', '*.mat', '*.playable'];

function pruneArgs(): string[] {
  return PRUNE.map((d) => `--exclude-dir=${d}`);
}

/** `guid: 0123abcd…` from a `.meta`. Returns '' when there is no meta or no guid line. */
export function guidOf(csAbs: string): string {
  const meta = `${csAbs}.meta`;
  if (!existsSync(meta)) return '';
  const m = /^guid:\s*([0-9a-f]{32})\s*$/m.exec(readFileSync(meta, 'utf-8'));
  return m ? m[1] : '';
}

/** Nearest enclosing `.asmdef`, walking up. The assembly a file actually compiles into. */
export function asmdefOf(absFile: string, root: string): string {
  let dir = dirname(absFile);
  const stop = root;
  for (let i = 0; i < 40; i++) {
    try {
      const hit = readdirSync(dir).find((f) => f.endsWith('.asmdef'));
      if (hit) return relative(root, join(dir, hit)).split(sep).join('/');
    } catch { /* unreadable directory is not an answer */ }
    if (dir === stop || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return '';
}

/**
 * Where a DI container binds this file's type — the wiring that leaves no asset behind.
 *
 * DETERMINISTIC, and deliberately narrow: the type name must appear inside the angle brackets of a
 * `Bind<…>` on one line. That matches the forms Zenject actually uses in this codebase —
 * `Container.Bind<IDeckView>()`, `Bind<Foo>().To<Bar>()` — and matches nothing that merely mentions
 * the class. A looser rule ("named anywhere in an installer") would call every type an installer
 * touches "injected", which is how a useful fact becomes noise.
 *
 * The type name is taken from the FILENAME, which is the C# convention this codebase follows.
 */
/**
 * The binding forms that actually appear, counted in a real installer-heavy codebase:
 *
 *     Bind                     417
 *     BindInterfacesTo         284
 *     BindInterfacesAndSelfTo  163
 *     To                        73
 *
 * Matching only `Bind<` — the obvious form, and the one that comes to mind first — would have missed
 * 447 of 937 bindings, very nearly half. `DeckService` is bound by `BindInterfacesAndSelfTo<>` and
 * would have been reported as reached by nothing at all.
 */
const BIND_FORMS = '(Bind|BindInterfacesTo|BindInterfacesAndSelfTo|BindFactory|To)';

export async function bindingsOf(
  root: string,
  rel: string,
): Promise<Array<{ file: string; line: number; text: string }>> {
  const type = rel.split('/').pop()?.replace(/\.cs$/i, '') ?? '';
  if (!type || type.length < 3) return [];
  const r = await runProbe(
    ['grep', '-rnI', ...pruneArgs(), '--include=*.cs', '-E', `\\b${BIND_FORMS}<[^>]*\\b${type}\\b[^>]*>`, '.'],
    root,
  );
  const out: Array<{ file: string; line: number; text: string }> = [];
  for (const line of r.lines.slice(0, 8)) {
    const parsed = parseGrepLine(line);
    if (!parsed) continue;
    const file = parsed.file.replace(/^\.\//, '');
    if (file === rel) continue;              // a type binding itself is not someone else wiring it
    out.push({ file, line: parsed.line, text: parsed.text.trim().slice(0, 200) });
  }
  return out;
}

export const unity: ProjectExplorer = {
  id: 'unity',

  matches(root) {
    return existsSync(join(root, 'Assets')) &&
      (existsSync(join(root, 'ProjectSettings')) || existsSync(join(root, 'Packages')));
  },

  sourceIncludes: ['*.cs'],

  plan(term) {
    const base = ['grep', '-rnI', ...pruneArgs(), '--include=*.cs'];
    return [
      // A DECLARATION of the term — the strongest kind of hit, so it is its own probe rather than a
      // post-filter over a broad one.
      {
        strategy: 'definition',
        reason: 'defines' as Reason,
        argv: [...base, '-E', `(class|struct|interface|enum|record)\\s+${term}\\b|\\b${PREFIX}${term}\\s*\\(|\\b(readonly\\s+)?[A-Za-z_<>,\\[\\]]+\\s+_?${term}\\s*[;=]`, '.'],
      },
      // Any mention, for reach.
      // `-w` would MISS the `_privateField` convention: underscore is a word character, so
      // `grep -w scoreMultiplier` does not match `_scoreMultiplier`. That convention is ubiquitous in
      // C# and common in TypeScript, and missing it means missing the field the question is about.
      { strategy: 'mentions', reason: 'mentions' as Reason, argv: [...base, '-E', `\\b_?${term}\\b`, '.'] },
      // Tests state the RULE. On a real question the clearest statement of the semantics was a test
      // assertion and no production line said it as plainly, so tests get their own probe and their
      // own reason rather than being ranked down as noise.
      {
        strategy: 'spec',
        reason: 'spec' as Reason,
        argv: ['grep', '-rnI', ...pruneArgs(), '--include=*.cs', '-E', `(Assert|Should|Expect).*${term}`, '.'],
      },
      // Animation events call methods by NAME. A method a clip calls has no compile-time caller.
      {
        strategy: 'anim-event',
        reason: 'anim-event' as Reason,
        argv: ['grep', '-rnI', ...pruneArgs(), '--include=*.anim', '--include=*.controller', '-F', term, '.'],
      },
      // A file named after the term.
      { strategy: 'filename', reason: 'filename' as Reason, argv: ['find', '.', '-name', `*${term}*.cs`, '-not', '-path', './Library/*', '-not', '-path', './.git/*'] },
    ];
  },

  /**
   * The step a generic explorer cannot do: resolve each hit file's GUID and find the assets wiring
   * it into the game, plus the assembly it compiles into.
   */
  async glue(findings, root) {
    const out: Finding[] = [];
    const files = [...new Set(findings.map((f) => f.span.file))].slice(0, 6);
    for (const rel of files) {
      const abs = join(root, rel);
      const asm = asmdefOf(abs, root);
      if (asm) {
        out.push({
          span: { file: asm, fromLine: 1, toLine: 1, text: '' },
          reason: 'assembly', detail: `${rel} compiles into ${asm}`, score: 0.2,
        });
      }
      const guid = guidOf(abs);
      if (!guid) continue;
      const inc = ASSET_GLOBS.map((g) => `--include=${g}`);
      const r = await runProbe(['grep', '-rlI', ...pruneArgs(), ...inc, '-F', guid, '.'], root);
      for (const assetPath of r.lines.slice(0, 8)) {
        const clean = assetPath.replace(/^\.\//, '');
        // `.anim` and `.asset` are called out because they are the two people forget: animation
        // clips bind methods by string, and ScriptableObjects hold the configuration.
        const kind = clean.endsWith('.anim') || clean.endsWith('.controller') ? 'anim-event'
          : 'asset-ref';
        out.push({
          span: { file: clean, fromLine: 1, toLine: 1, text: '' },
          reason: kind as Reason,
          detail: `${clean} references ${rel} by guid ${guid.slice(0, 12)}…`,
          score: kind === 'anim-event' ? 0.9 : 0.7,
        });
      }
      if (r.lines.length === 0) {
        // "NO ASSET REFERENCES THIS" IS ONLY TWO THIRDS OF AN ANSWER.
        //
        // A C# class reaches the running game three ways: a GUID reference from an asset, an animation
        // event calling it by name, and a DI container binding it. The third leaves no trace in any
        // asset, so a service wired entirely by `Container.Bind<Foo>()` reported "used in 0 assets" —
        // true, and indistinguishable from dead code, which is the worst kind of true.
        const bound = await bindingsOf(root, rel);
        for (const b of bound.slice(0, 4)) {
          out.push({
            span: { file: b.file, fromLine: b.line, toLine: b.line, text: b.text },
            reason: 'injected',
            detail: `${rel} is bound by the container here`,
            score: 0.75,
          });
        }
        out.push({
          span: { file: rel, fromLine: 1, toLine: 1, text: '' },
          reason: 'asset-ref',
          detail: bound.length
            ? `no asset references ${rel} (guid ${guid.slice(0, 12)}… ) — reached through the container, not the scene`
            : `no asset references ${rel} (guid ${guid.slice(0, 12)}… ) — plain C#, no scene wiring`,
          score: 0.05, fixedScore: true,
        });
      }
    }
    return out;
  },

  /** Walk back to the nearest member signature. Returns undefined rather than guessing. */
  symbolAt(lines, line) {
    const MEMBER = /^\s*(?:\[[^\]]*\]\s*)?(?:public|private|protected|internal)[^;{=]*?\b(\w+)\s*\(/;
    const TYPE = /^\s*(?:public|private|protected|internal|abstract|sealed|static|partial|\s)*\b(?:class|struct|interface|enum|record)\s+(\w+)/;
    for (let i = Math.min(line, lines.length); i > 0 && line - i < 80; i--) {
      const t = lines[i - 1] ?? '';
      const m = MEMBER.exec(t);
      if (m) return `${m[1]}()`;
      const c = TYPE.exec(t);
      if (c) return c[1];
    }
    return undefined;
  },
};

/** Exported for the gate: the asset families that carry GUID references. */
export const UNITY_ASSET_GLOBS = ASSET_GLOBS;
export function isUnityRoot(root: string): boolean {
  try { return statSync(join(root, 'Assets')).isDirectory(); } catch { return false; }
}
