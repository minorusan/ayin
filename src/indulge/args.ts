/**
 * indulge/args.ts — argument shapes, kept out of the CLI module so they can be tested.
 *
 * `index.ts` runs work at import time (it wires the tool runtime), so a gate that wanted to check a
 * pure parser had to boot the whole command to reach it. A parser is a function; it belongs where a
 * test can import it alone.
 */

/**
 * A list argument — `["a","b"]` or `a,b`. Used by BOTH `--domains` and `--categories`.
 *
 * Uniform on purpose, and it was not: domains took a quoted comma string and categories took an
 * unquoted one, so the same idea had two spellings and neither was the array shape they were specced
 * as. A caller reasonably writes `["reward service","game modes"]` and it has to work.
 *
 * The comma form still parses, because it is in shell histories and in every example written so far,
 * and breaking it to make a point would cost more than the inconsistency did. JSON is tried first:
 * a value starting with `[` is unambiguous, and falling back on a parse failure means a malformed
 * array degrades to one long item rather than an error nobody can read.
 */
export function parseList(raw: string): string[] {
  const v = raw.trim();
  if (v.startsWith('[')) {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x).trim()).filter(Boolean);
      }
    } catch { /* not valid JSON — fall through and treat it as text */ }
  }
  // A value that opened with `[` but did not parse is a malformed array, not prose — strip the
  // brackets before splitting, or `["broken",` yields an item literally called `["broken`, which then
  // becomes a domain that matches nothing and a report line nobody can read.
  const body = v.startsWith('[') ? v.replace(/^\[/, '').replace(/\]$/, '') : v;
  return body.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

