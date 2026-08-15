# `/testrun` — the tests that cover what you're working on

```
/testrun <domains>              e.g. /testrun reward service
/testrun a, b                   several domains
ayin testrun "<domains>"        same, from a shell
ayin testrun "<domains>" --list show what would run, run nothing
```

C#/Unity today. Selection is entirely deterministic; the only interactive moment is whether Unity
may be quit.

---

## Selection: three signals, none of them a model

```
domains → FILES        the corpus already records a domain on every chunk
files   → ASSEMBLY     nearest ancestor .asmdef  (Unity's own rule)
assembly → TESTS       the three reasons below
```

**The domain step is a lookup, not a judgement.** `indulge` already asked a model which files a
domain covers, verified every citation against the repo, and wrote the domains onto each chunk.
Asking again at test time would be a second, unverified opinion about a question already answered
with evidence.

With no corpus, the domain words are matched against assembly names and paths instead — and the
report **says it guessed**, because a run that quietly selected the wrong assemblies and passed is
worse than one that admits it doesn't know.

### The three admissible reasons

| reason | meaning |
|---|---|
| `contains` | the file is inside the test assembly itself |
| `references` | the test assembly directly references the owning assembly, and that assembly is not a hub |
| `named` | the assembly is named after a directory on the file's path |

**Transitive references are deliberately absent, and that is the whole story of this file.** The
first run against a real project selected **25 of 26 test assemblies for a single source file**:
everything under `Assets/Scripts` lives in one `Core` assembly, and every test references it. Reaching
a file through a hub is not evidence of coverage — it is evidence the project has a hub.

So an assembly referenced by ≥30% of test assemblies is **ambient** and referencing it proves
nothing, exactly as `indulge` treats a type mentioned by 25+ files. When the owner is ambient, path
and name carry the decision instead. Same file after: **2 assemblies, both correct.**

`named` exists because that project also keeps a central `Assets/Tests/` directory. `MultiQuestTests`
lives there, shares one path segment with the code it covers, and reaches it only through `Core` — so
neither reference nor proximity can find it. The name is the last signal standing, it is weaker, and
the report labels it.

### Detecting a test assembly

`defineConstraints: ["UNITY_INCLUDE_TESTS"]` — Unity's own marker, used to keep tests out of player
builds.

Two weaker rules were tried first and both under-reported. `nunit.framework.dll` in
`precompiledReferences` misses assemblies that declare an **empty** `precompiledReferences` and pull
NUnit through the package; six real ones do exactly that, and every one was classified as production
code and silently never run. Matching known TestRunner GUIDs missed them too — those GUIDs vary by
package version and are not a contract. Naming is worse still: the same project uses
`*.Tests.Editor`, `*.Tests.Play`, `*.PlayTests`, `*Tests` and `*TestsEditor`.

Switching to the define constraint found **6 test assemblies that were being skipped**.

---

## Running: two paths

**Prebuilt** — NUnit over `Library/ScriptAssemblies/*.dll`, which the Editor already compiled.
Seconds, no licence, no lock. This is the normal path.

**Batch mode** — `Unity -batchmode -runTests -assemblyNames …`. Authoritative, minutes, and it needs
the project to itself. `-assemblyNames` is what makes a domain-scoped run possible: without it Unity
runs every test in the project.

**Staleness is the load-bearing check.** A DLL older than its sources tests code that no longer
exists, and reports green for it. That is the one output worth refusing to produce, so it is measured
(`mtime` of the DLL vs the newest `.cs` under the asmdef) and never assumed. "Never compiled" is
reported separately from "stale" — they send you looking for different things.

### The prompt

Appears when the Editor holds the project (`Temp/UnityLockfile`), because that is the only moment the
choice matters:

```
Unity has this project open. Batch mode needs it closed.

  Run the N already-compiled assemblies    seconds · leaves Unity alone · skips anything stale
  Quit Unity and run batch mode            authoritative · costs a domain reload on reopen
  Cancel
```

Quitting is **graceful only**. A SIGKILL on Unity loses unsaved scene and prefab edits and can leave
`Library/` half-written. If the Editor doesn't release the lock within 30s the usual reason is a
save-changes modal waiting for a human — which from here is indistinguishable from a hang — so
`/testrun` says so and stops rather than escalating.

### `confirm` — asking the operator

The prompt goes through a new `ToolServices.confirm` delegate (`tools/runtime.ts`), the counterpart
to `llm.ask`: same shape, other party. A tool that reaches outside the repo can ask before it does,
without importing the host's UI.

**It returns `null` when there is nobody to ask, and null is a refusal.** Headless `-p`, `ayin watch`
and every scheduled run have no answerer, and a tool that quits the operator's editor because a cron
job couldn't be asked is the bug this signature exists to prevent. Same rule as the always-confirm
git gate.

---

## The report

```
reward service → 2 test assembly(ies)
ran via Library/ScriptAssemblies (already compiled)

  ✓ Vendor.Scoring.Tests.Editor  14 passed · 0 failed · 1 skipped
  ✗ Vendor.Scoring.Tests.Play — NOT RUN: could not load (engine types?)

14 passed · 0 failed · 1 skipped · 1 assembly(ies) NOT RUN
A not-run assembly is not a pass — the summary above excludes it deliberately.
```

**`NOT RUN` is a first-class line, never folded into the totals.** An engine-coupled assembly throws
at fixture setup outside the player; that is a fact to report, not a pass. Same rule as the corpus's
unproven chunks and `/diff`'s hidden-file count.

---

## Config

```
/set nunit-console <path>    the NUnit console runner
/set unity-path <path>       the matching Editor, when the Hub layout isn't where it's guessed
```

Both are machine-specific paths, so both are config with detection as the fallback. A missing runner
is reported as a **setup** problem with the fix in the message — not as a test failure. A missing
runner and a failing assertion produce the same exit code, and telling them apart is the difference
between a five-minute fix and an afternoon.

---

## Gate

`npm run check:testrun` — no .NET, no Unity, no network. That split is the point: everything that
*decides* what to run is pure and testable anywhere, while the part that shells out is deliberately
thin.

It builds a synthetic project containing the shapes that actually bite — a `LiveOps` /
`LiveOpsChallenges` pair (a string-prefix match hands one's files to the other), a hub referenced by
most test assemblies, an assembly marked only by the define constraint, and a central `Tests/`
directory reachable only by name — and asserts selection, staleness in both directions, NUnit XML
parsing, that `NOT RUN` never reads as a pass, and that `confirm` refuses when unanswerable.

> The execution layer has **not** been exercised against a real .NET toolchain or a real Unity
> install — neither exists on the machine this was written on. Selection is verified against the real
> 93-asmdef project; running is not.
