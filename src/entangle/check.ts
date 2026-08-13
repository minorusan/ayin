/**
 * The rules. Nothing here knows what a language is — it consumes a `Design` and a `SurfaceLanguage`,
 * which is what makes adding Python one implementation rather than a change to the rules.
 *
 * Four checks, in the order they matter:
 *
 *  CLOSURE  a type the design does not declare must not exist. This is the one that kills the invented
 *           proxy on the write that creates it. Measured on a real sprint: three interfaces existed for
 *           no purpose but to mediate calls the diagram had going direct.
 *  DOMAIN   a reference the file's manifest does not permit. The `sealed` case is called out separately
 *           because it is the constraint models actually respect, so breaking it is worth naming loudly.
 *  MEMBER   a PUBLIC member the design does not declare. Private members are free — the implementation
 *           freedom the operator asked for, and over-constraining it makes a model hide structure in
 *           tuples and 200-line methods instead, which is worse and invisible here.
 *  ADOPTION a designed type nobody implemented. Deliberately NOT run per write — a file being written
 *           cannot know what other files will contain — so it is the end-of-task check, and it is the
 *           one that catches what review structurally cannot: absence. On the measured sprint, two
 *           specified integration points into existing code were never touched and nothing noticed.
 *
 * Type COUNT is never the test. That sprint went 36 designed → 38 built, which looks healthy, while 15
 * were surplus and 9 designed types were never written. Identity, not cardinality.
 */

import type { Design, DeclaredType, Domain, SurfaceLanguage, Violation } from './types.js';

/**
 * Type names a member signature mentions. Splits on everything that is not an identifier, so
 * `Dictionary<string,RewardType>[]` yields Dictionary, string, RewardType.
 */
function namesIn(sig: string): string[] {
  return sig.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
}

/** Checks for ONE file, at the moment it is about to be written. */
export function checkFile(
  design: Design,
  lang: SurfaceLanguage,
  file: string,
  source: string,
): Violation[] {
  const out: Violation[] = [];
  const declared = lang.surfaceOf(source);

  for (const t of declared) {
    const designed = design.types.get(t.name);
    if (!designed) {
      out.push({
        rule: 'CLOSURE', subject: t.name, file,
        gap: `${t.kind} "${t.name}" is not in the design (${design.source})`,
      });
      continue; // its members are moot until the type itself is resolved
    }
    if (designed.kind !== t.kind) {
      out.push({
        rule: 'CLOSURE', subject: t.name, file,
        gap: `design declares "${t.name}" as a ${designed.kind}; this declares a ${t.kind}`,
      });
    }
    for (const m of t.members) {
      if (m.visibility !== 'public') continue;
      if (!designed.members.includes(m.name)) {
        out.push({
          rule: 'MEMBER', subject: `${t.name}.${m.name}`, file,
          gap: `public ${m.kind} "${m.name}" is not on "${t.name}" in the design`,
        });
        continue;
      }
      // SIGNATURE. Name-only matching let the last real hole through: told `Telemetry` was undesigned,
      // the model kept the member and changed its parameter — `Feed(Telemetry)` became
      // `Feed(string id)`. Same name, so MEMBER passed, and the contract had quietly moved.
      //
      // Design signatures are informal — `Close(isWin, ratio)` names PARAMETERS, not types — so a
      // strict comparison would fire on every one. Only CAPITALIZED names in the designed signature are
      // treated as types that must survive, which is the same convention the reference rule leans on and
      // costs no false positives on `isWin`.
      const designedSig = designed.spec.find((x) => x.sig.replace(/^[+\-#~]/, '').trimStart().startsWith(m.name))?.sig;
      if (!designedSig || !m.sig) continue;
      const inner = /\(([^)]*)\)/.exec(designedSig);
      if (!inner) continue;
      for (const want of namesIn(inner[1])) {
        if (!/^[A-Z]/.test(want) || lang.isBuiltinType(want)) continue;
        if (new RegExp(`\\b${want}\\b`).test(m.sig)) continue;
        out.push({
          rule: 'SIGNATURE', subject: `${t.name}.${m.name}`, file,
          gap: `design declares "${designedSig.replace(/^[+\-#~]/, '').trim()}" but this signature does not `
            + `mention "${want}" — a member kept while its parameter changed is the contract moving quietly`,
        });
      }
    }
  }

  // REFERENCE — a signature naming a type nobody designed. Declaring an undesigned type and merely
  // NAMING one are the same violation, and naming is the form the hardest case takes: the trial's
  // `Feed(Telemetry)` needs a type that exists nowhere in the design, so a check that only looks at
  // declarations passes a file that cannot compile. Identifiers the language calls its own furniture
  // (`int`, `Dictionary`, `Func`) are skipped, and each language errs toward calling them builtin —
  // a false stop on `string` would make this unusable, while a miss only costs a review.
  const declaredHere = new Set(declared.map((t) => t.name));
  const flagged = new Set<string>();
  for (const name of referencedTypeNames(source)) {
    if (flagged.has(name) || declaredHere.has(name)) continue;
    // ONLY CAPITALIZED IDENTIFIERS. Every keyword in C# and TypeScript is lowercase — `public`, `class`,
    // `void`, `int`, `get`, `readonly` — and every type a design declares is PascalCase by universal
    // convention in both languages. Four separate false positives came from a keyword leaking through a
    // signature pattern (`class` as a field type, `public` as a constructor's return type, and two more);
    // this one rule retires the whole class of them, where each regex fix retired exactly one.
    //
    // The cost, stated: a design that names a type in lower case is not checked. That is a trade worth
    // making — a tool that stops on `public` is not used at all.
    if (!/^[A-Z]/.test(name)) continue;
    if (lang.isBuiltinType(name)) continue;
    if (design.types.has(name)) continue;
    flagged.add(name);
    out.push({
      rule: 'REFERENCE', subject: name, file,
      gap: `"${name}" is used here but the design declares no such type (${design.source})`,
    });
  }

  out.push(...checkDomain(lang, file, source));
  return out;
}

/**
 * Identifiers used in a TYPE POSITION: parameter types, return types, field types, base lists. Bodies are
 * deliberately not scanned — a local variable or a method call is not a design fact, and scanning them
 * would flag every helper the implementer is allowed to have.
 */
function referencedTypeNames(source: string): string[] {
  const out = new Set<string>();
  for (const raw of source.split('\n')) {
    let line = raw.replace(/\/\/.*$/, '').trim();
    if (!line || line.startsWith('*') || line.startsWith('///') || line.startsWith('[')) continue;

    // A DECLARATION contributes its base list. Parsed FIRST, or the member patterns below read
    // `public class Foo {` as a field whose type is the keyword `class`.
    //
    // But a declaration can carry its whole body on the same line — `public struct P { public int X; }` —
    // so after taking the base list we CONTINUE SCANNING the text past the brace instead of skipping the
    // line. Skipping it silently hid every member of a single-line type, which is how the hardest trap in
    // the trial went from caught to passing.
    const decl = /\b(?:class|interface|struct|enum|record)\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*([^{]+))?\s*(?:\{|$)/.exec(line);
    if (decl) {
      if (decl[1]) for (const n of namesIn(decl[1])) out.add(n);
      const brace = line.indexOf('{');
      if (brace === -1) continue;
      line = line.slice(brace + 1).trim();
      if (!line || line === '}') continue;
    }
    if (/^(namespace|using|return|if|for|foreach|while|switch|throw|new|else|try|catch|finally|do|lock|get|set)\b/.test(line)) continue;

    // A method: return type plus every parameter's type. Modifiers are OPTIONAL — an interface member
    // has none, which is how the first version missed every contract it was built to check.
    const call = /^(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|new|partial)\s+)*([A-Za-z_][A-Za-z0-9_<>,\[\]\.\? ]*?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/.exec(line);
    if (call) {
      for (const n of namesIn(call[1])) out.add(n);
      for (const param of call[3].split(',')) {
        const parts = namesIn(param.replace(/\b(ref|out|in|params|this)\b/g, ''));
        // `RewardType kind` → the type is everything but the trailing parameter NAME
        if (parts.length >= 2) for (const n of parts.slice(0, -1)) out.add(n);
        else if (parts.length === 1) out.add(parts[0]);
      }
      continue;
    }

    // A field, property or event, modifiers equally optional.
    const field = /^(?:(?:public|private|protected|internal|static|readonly|const|event|virtual|override|abstract)\s+)*([A-Za-z_][A-Za-z0-9_<>,\[\]\.\? ]*?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{|;|=>|=)/.exec(line);
    if (field) for (const n of namesIn(field[1])) out.add(n);
  }
  return [...out];
}

/** Reference permission, from the file's own manifest. Silent when the file is in no domain. */
export function checkDomain(lang: SurfaceLanguage, file: string, source: string): Violation[] {
  const domain: Domain | null = lang.domainOf(file);
  if (!domain) return [];
  const out: Violation[] = [];
  for (const ref of lang.referencesOf(source)) {
    if (lang.isPlatform(ref, domain)) continue;
    if (domain.allows.some((a) => ref === a || ref.startsWith(`${a}.`) || ref.startsWith(`${a}/`))) continue;
    if (isOwnDomain(ref, domain.name)) continue;
    out.push({
      rule: 'DOMAIN', subject: ref, file,
      gap: domain.sealed
        ? `"${domain.name}" is declared self-contained and references nothing; this adds "${ref}" (${domain.manifest})`
        : `"${domain.name}" does not list "${ref}" among its references (${domain.manifest})`,
    });
  }
  return out;
}

/** A unit may always reference itself; namespaces and package names both nest by prefix. */
function isOwnDomain(ref: string, domain: string): boolean {
  return ref === domain || ref.startsWith(`${domain}.`) || ref.startsWith(`${domain}/`);
}

/**
 * ADOPTION, across everything implemented so far. Run at the END of a task, never per write: absence is
 * not a property of one file. `implemented` is every type name seen across the entangled tree.
 */
export function checkAdoption(design: Design, implemented: Set<string>): Violation[] {
  const out: Violation[] = [];
  // SCOPED TO THE DOMAINS BEING WORKED IN. Unscoped, a task to implement one assembly was told 23 types
  // were missing — most of them in assemblies it had never been asked to touch. That is not a completion
  // criterion, it is a wall, and in the trial the model responded to the wall by trying to switch the
  // gate off. Once anything has been implemented, the domains it landed in ARE the scope; before that,
  // nothing has been claimed and the whole design is fair to report.
  const activeDomains = new Set<string>();
  for (const [name, t] of design.types) if (implemented.has(name)) activeDomains.add(t.domain);

  for (const [name, t] of design.types) {
    if (implemented.has(name)) continue;
    if (activeDomains.size > 0 && !activeDomains.has(t.domain)) continue;
    out.push({
      rule: 'ADOPTION', subject: name, file: design.source,
      gap: `design declares ${t.kind} "${name}"${t.domain ? ` in ${t.domain}` : ''} and nothing implements it`,
    });
  }
  return out;
}

/**
 * STOP · the gap · the options. The report a violation turns into.
 *
 * The options are left to the AGENT to fill in — it just did the work and knows why it wanted the
 * deviation, which no graph query can reconstruct. What is deterministic is that the turn stops; the
 * suggestion is advice for a human who will reject the bad ones in seconds. That division is the whole
 * design: a mechanical stop, a human decision.
 */
export function renderStop(violations: Violation[], designSource: string): string {
  const lines = [
    `ENTANGLED — STOP. ${violations.length} violation(s) against ${designSource}.`,
    '',
    'The write did NOT land. Do not work around this, do not rename, do not move the declaration',
    'elsewhere, and do not edit the design file.',
    '',
  ];
  for (const v of violations) {
    lines.push(`  [${v.rule}] ${v.subject}`);
    lines.push(`     ${v.gap}`);
  }
  lines.push('');
  lines.push('Report to the operator, in this order, and then WAIT:');
  lines.push('  1. what you were adding, and why you believed you needed it;');
  lines.push('  2. every option you can see, worst to best, including the ones you dislike —');
  lines.push('     name which existing designed types you considered and why they did not fit;');
  lines.push('  3. your recommendation, as one option among them, not as a decision.');
  lines.push('');
  lines.push('Amending the design is a legitimate outcome. It is the operator\'s to make, not yours.');
  return lines.join('\n');
}
