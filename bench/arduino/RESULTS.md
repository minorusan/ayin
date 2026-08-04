# Arduino benchmark — results log

One section per attempt. The point of writing these down is that "ayin got better at Arduino" is
otherwise a feeling. Each attempt records the score, what failed, and **what was changed in response**
— so a later attempt can tell a real improvement from a lucky sample.

Scored with `node tool/arduino-bench.mjs grade <dir>`; run with `tool/arduino-bench-run.sh <dir>`.

---

## Attempt 1 — 2026-08-04, ayin 1.0.222, qwen3.6:27b

`AYIN_PLAN=1 AYIN_QA=1`, headless, one empty non-git directory per project.

**139/156 checks (89%), 10/10 projects, ~25 min total.**

| # | Project | Score | Time | Compiles |
|---|---|---|---|---|
| 1 | Blink | 13/13 | 48s | yes |
| 2 | RGB cycle + button | 16/16 | 242s | yes |
| 3 | Pedestrian crossing | 14/15 | 259s | yes |
| 3 | Automatic night light | 16/16 | 195s | yes |
| 4 | Reaction timer | 13/16 | 151s | **NO** |
| 4 | Servo + potentiometer | 14/16 | 73s | **NO** |
| 5 | Parking sensor | 15/17 | 151s | **NO** |
| 6 | Room climate display | 12/15 | 144s | n/a (needs libs) |
| 7 | Eight-LED bar (74HC595) | 13/17 | 128s | **NO** |
| 8 | NeoPixel strip | 13/15 | 157s | **NO** |

**Five of ten did not compile**, all from the same cause (finding 2). The score is the least interesting
output here; the findings below are the point.

### Finding 1 — the QA gate silently did not run (the worst kind of failure)

`qaChangedFiles()` is tool-tracked writes ∪ `git status`. A fresh Arduino directory **is not a git
repo**, so the git half returned null; the projects that wrote their files through `bash` rather than
`write_file` therefore reported **zero changed files**, and `qaShouldRun` declined with "nothing
changed this turn". The gate did not fail — it never looked. Nothing in the output said so.

Cost: reaction-timer, servo-dial and parking-sensor all shipped sketches **that could not compile**,
past a naming bar and a compile probe that both existed and never got the chance to run.

**Fixed:** `filesModifiedSince()` in `qa/probes.ts` — outside a repo, fall back to an mtime scan of the
project root since the turn began. Verified against the reaction-timer directory: finds all four files
the gate had been blind to.

### Finding 2 — hyphen/underscore renaming broke the build in 3 of 7 projects

`servo-dial/servo_dial.ino`, `reaction-timer/reaction_timer.ino`,
`parking-sensor/parking_sensor.ino`. Each "normalised" the hyphen in the *filename* while leaving the
folder alone, and the toolchain requires an exact match. Verified with `arduino-cli` that hyphens are
perfectly legal (`has-hyphen/has-hyphen.ino` compiles) — so this is ayin's error, not the harness's.

**Fixed:** the rule in `prompts/arduino/planGrounding.txt` and
`prompts/qa/baselineArduinoSketchNaming.txt` now says hyphens are legal and names this exact failure.

### Finding 3 — one project hand-wrote its "generated" wiring diagram

`traffic-light.wiring.puml` was valid PlantUML, plausible, resistors and all — and written by the
model, with **zero catalog grounding**. It survived because `prepare()`'s mtime skip assumed this tool
was the only writer of that path. A plausible wrong pinout is worse than no diagram, because someone
wires it.

**Fixed:** generated diagrams carry a provenance stamp (`PROVENANCE_MARK`); an unstamped `.puml` is
regenerated regardless of mtime and reported to the judge as a failure. Verified: traffic-light's file
has no `COMP_<catalog-id>` aliases, rgb-cycle's does.

### Finding 4 — plan mode was vetoed on single-feature Arduino requests

Triage answered "single-feature request (255 chars)" for the reaction timer, which is *true* and also
meant the Arduino block never reached the model: no component catalog, no PWM rule, no naming rule.
The grounding was withheld exactly where it was needed — the same shape as the greenfield bug.

**Fixed:** a triage veto is only honoured when the project type brings no domain grounding.

### Finding 5 — the fix for finding 4 was a speed regression, caught in the first project

An aborted attempt 2 ran with the triage-veto override in place. **Blink went 48s → 193s**, and ~145s
of that was generating a **5,185-character nine-section plan document for a sketch with two calls in
it**. Correct about the facts, wrong about the instrument: what that request needed was the four
build-breaking rules (a deterministic string, free) and not a plan.

**Fixed:** `runPlan` now has two outcomes — `kind: 'plan'` (the full document, when triage says complex
or the user said `/planthis`) and `kind: 'grounding'` (reference material only, no document, nothing
written, **zero extra LLM calls**). `planContextBlock` switches on `kind`, because the `<plan>` wrapper
tells the model to "follow the plan" and "work the steps in order" — instructions about a file that
does not exist in the grounding case.

That aborted run was **stopped after two projects** rather than completed: finishing it would have spent
~45 minutes of shared GPU validating a configuration already known to be the wrong one. Blink still
scored 13/13, which was the question worth answering.

### Finding 6 — library-constructor pins were invisible, so a diagram had no components

`DHT dht(DHT_PIN, DHT_TYPE);` configures its pin inside the library, so the sketch never calls
`pinMode`. The climate-display project — a *correct* sketch with `#define DHT_PIN 2` — produced a
wiring diagram containing **one rectangle**: the empty board. Valid PlantUML, zero components, useless.
I2C made it worse: SDA/SCL appear nowhere in source, so an I2C display is absent from its own diagram.

**Fixed:** `LIBRARY_PIN_ARGS` (a curated type → argument-position map, deliberately not a general "first
integer argument" rule — `LiquidCrystal_I2C lcd(0x27, 16, 2)` must never yield three fictional wires)
plus synthetic SDA/SCL pins when an I2C library is included. Verified against the real failing sketch:
0 pins → 3 (`DHT_PIN→2`, `A4 I2C SDA`, `A5 I2C SCL`).

---

## Attempt 2 — ABORTED after 3 projects (2026-08-04)

Stopped deliberately, twice, rather than run to completion. Both times the run had already told me the
configuration under test was wrong, and finishing would have spent ~40 minutes of shared GPU confirming
it. Blink's score was the question each run could still answer, and it answered it.

Score at abort: blink **10/13** (down from 13/13), traffic-light 9/13. Both lost the same three checks:
**no wiring diagram at all.**

### Finding 7 — the QA gate read the WRONG message (second independent reason it never ran)

`qa_gate_condition: run=false, why="final message is not a completion report", files=2, hasText=false`.

Note `files: 2` — the non-git fallback from finding 1 **worked**. The gate still declined, for an
entirely separate reason: headless exits on **double text**. Round N prints the real completion report,
round N+1 repeats it or emits nothing, and the loop ends there — so `qaShouldRun` was handed round
N+1's empty response. The text ayin had just printed ended with the literal words "Ready for QA".

**Fixed:** the shape check now reads `parsed.text || lastPrintedText || response`. Two independent bugs
had to be fixed before the gate ran at all; the first one alone looked like a complete fix.

### Finding 8 — a required deliverable depended on two conditional producers, and both were off

The wiring diagram was produced either by the agent calling `arduino_diagram` itself, or by the QA
executor's `prepare()`. In attempt 1 the **plan document** listed "run arduino_diagram" as a step, so
the agent did it. On the grounding-only path there is no plan — and QA, the backstop, declined for
finding 7. Two optional producers, both silent, and a REQUIRED file simply absent.

**Fixed:** three ways, because a required deliverable should not be one edit away from vanishing again.
1. An **unconditional** post-turn hook in `agent.ts` regenerates diagrams whenever a sketch is among the
   turn's changed files — independent of QA, Presenter and their toggles.
2. `isDiagramCurrent()` moved from the QA executor **into** `arduino-diagram.ts`, so the mtime +
   provenance skip is a property of the operation and every caller gets it. Previously any other caller
   re-spent a grounding LLM call, and a new one had to remember to reimplement the check.
3. The grounding block's wording said *"Plan the step as: run arduino_diagram"* — an instruction to plan,
   in a mode with no plan. Now: "After the sketch is written, call the arduino_diagram tool."

### Finding 9 — an empty scaffold stub is worse than no README

`README is written, not a stub — still the untouched scaffold stub`. `scaffold()` writes the stub and the
**plan document** was the only thing that ever told the agent to fill it in. On the grounding path the
stub shipped untouched — and a stub *passes* any check that only asks whether a README exists.

**Fixed:** the deliverable list now reaches the model on **both** paths (one shared
`renderDeliverableList`, used by the plan document and the grounding block, which is where it should
have been from the start), and it states that a stub counts as MISSING. The stub itself now carries
explicit `TODO` markers so its incompleteness is visible to a reader and to a checker, and the grader
fails any README with a `TODO` left in it.

### Finding 10 — the stub check had to be ENFORCED, not requested

`traffic-light` shipped a README with **5 TODO markers** still in it, even with the deliverable list
telling the model that a stub counts as missing. Asking was not enough.

**Fixed:** `readmeSubstance()` in `executors/deliverables.ts`, wired into BOTH QA executors as a probe
fact. A README carrying `TODO`, or under 200 characters, is reported to the judge as not satisfied —
the same reasoning as running a compiler instead of asking a model whether the sketch builds. Enforce,
do not request.

### FOUR bugs in the GRADER itself, all the same species

Each one nearly caused a "fix" to ayin for a defect in the instrument:

1. Headings were counted inside fenced code, so `# Compile` in a bash fence read as an empty heading —
   failing an excellent README.
2. Then fences were *stripped*, which made the "## Build & Upload" section (whose body **is** a fence)
   read as empty.
3. A pin map formatted as a table (`| 8 | Red LED |`) failed a `pin\s*\d` adjacency check.
4. `## Wiring` followed by `### RGB LED` — a parent heading containing subsections, which is simply how
   markdown nests — was counted as empty. The check is now heading-LEVEL aware: a gap requires no prose
   of its own AND a next heading that is not nested beneath it.

**Measure the measurement.** A grader that fails good work teaches you to break things.

---

## Attempt 3 — 2026-08-04, all fixes from findings 1-10

Smoke-tested on one project before committing a full run: blink **13/13 in 65s**, diagram present and
carrying the provenance stamp, and `LED_BUILTIN` resolving so the pin renders as `LED_BUILTIN (13)`
instead of a bare name. Compare 48s (attempt 1 — diagram present, but only because that run's plan
document happened to list the tool) and 193s (the aborted full-plan path).

### The seven-project ladder, and one PASS/FAIL per project

`tool/arduino-legit.mjs` answers the question actually being asked — *are these real, working Arduino
projects?* — with no partial credit. A project is LEGIT only if all six hold: it **compiles** with real
`arduino-cli`; the sketch **filename matches its folder**; the README has a **parts list, pin map and
build commands with no TODO left**; a **`.wiring.puml` + `.svg`** exist carrying the generator's
**provenance stamp**; the real PlantUML renderer **parses** it; and no `analogWrite` lands on a pin
without hardware PWM. A project at 14/15 on the benchmark can still fail to compile, which is why the
score was the wrong instrument for this question.

| # | Project | Attempt 1 | Attempt 3 |
|---|---|---|---|
| 1 | Blink | not legit | **LEGIT** · 13/13 · 65s |
| 2 | RGB cycle + button | not legit | **LEGIT** · 16/16 · 230s |
| 3 | Pedestrian crossing | not legit | **LEGIT** · 15/15 · 575s |
| 4 | Automatic night light | not legit | **LEGIT** · 16/16 · 127s |
| 5 | Reaction timer | not legit (did not compile) | **LEGIT** · 16/17 · 192s |
| 6 | Parking sensor | not legit (did not compile) | **LEGIT** · 18/18 · 261s |
| 7 | Room climate display | not legit | ✗ stub README at root |

**Baseline 0/7 → 6/7 legit.** Across all ten benchmark projects (the ladder plus three extras):
**139/156 (89%) → 152/157 (97%)**, and **10/10 compile** where five previously did not.

Reaction-timer's one remaining check is `randomSeed` — see finding 11.

Two traps confirmed handled rather than merely compiled: night-light maps its LDR reading with
`map(v, dark, bright, 255, 0)` — inverted, and into 0-255 rather than feeding a 0-1023 value to
`analogWrite`; traffic-light's diagram is grounded in `standard-led` + `push-button` with three series
resistors drawn as real nodes in the wire.

**A blocker removed to make #7 honest:** climate-display could never legitimately compile because the
DHT library was not installed. `arduino-cli lib install "DHT sensor library"` — so it is now
compile-verified rather than excused as "needs libraries".

### Bug 5 in the instrument — stripping `_` destroyed the token being searched for

The pin-map check stripped markdown emphasis `[*_`]` before testing, which turns `LED_BUILTIN` into
`LEDBUILTIN`. Blink was reported as having **no pin map** while its README names the pin. The strip
exists only so `**9**` still matches `pin\s*\d`; it must never eat identifier characters. Fixed in
both `arduino-legit.mjs` and `arduino-bench.mjs`, so the two instruments cannot disagree.

**Running tally: 10 bugs in ayin, 5 in my own measuring tools.** Every one of the five was a near-miss
where the instrument punished correct output — and where "fixing" ayin would have made it worse.

### Method note — a mid-run rebuild, and why it did not invalidate the numbers

`dist` was rebuilt after `rgb-cycle` finished, to add finding 10's `readme-substance` fact. So `blink`
and `rgb-cycle` ran without that in-run enforcement and everything after ran with it. Stated rather
than hidden: a benchmark whose binary changes mid-run is not a measurement.

Survivable here for two specific reasons — the **grader** is applied uniformly to the final files
afterwards, so the scores are comparable; and both affected projects have READMEs with **zero** TODO
markers, so the stricter check could not have fired on them. Compile, sketch naming and diagram
provenance are untouched by that change.

The rule, learned twice in this session: **never rebuild while a run is in flight.** Write the source,
typecheck with `--noEmit`, build when the run lands.

### What "master of Arduino" means on this suite

Not 156/156 — some checks encode a judgement worth arguing with (see the shift-register note in
`projects.json`). The floor that actually matters:

- **every sketch compiles.** Attempt 1: five of ten did not.
- **all four deliverables present**, with a README that is not a stub.
- **every diagram tool-generated and parsing** — no hand-drawn ungrounded pinouts.
- **no `analogWrite` on a non-PWM pin.**

Those are the failures that cost a person an evening with a multimeter.


---

## Run 4 — the wiring fixes, on the five projects that failed

Re-ran only the projects the wiring/README fixes touched. **All five: LEGIT and wiring-clean.**

| Project | attempt 3 legit | attempt 3 wiring | run 4 legit | run 4 wiring |
|---|---|---|---|---|
| rgb-cycle | ✅ | ✗ **dead circuit** | ✅ | ✅ |
| traffic-light | ✅ | ✗ 3 pins on one anode | ✅ | ✅ |
| night-light | ✅ | ✓ (weaker audit) | ✅ | ✅ |
| reaction-timer | ✅ | ✓ | ✅ | ✅ |
| climate-display | ✗ stub README | ✗ README pins | ✅ | ✅ |

### Finding 12 — the wiring diagram was electrically WRONG, and nothing else could see it

The defect the whole wiring audit exists for. rgb-cycle's diagram was valid PlantUML, provenance-stamped
and catalog-grounded — and unbuildable:

```
PIN_9  → 220Ω → red anode              correct
PIN_10 → common cathode (longest leg)   WRONG — belongs at ground
PIN_11 → common cathode (longest leg)   WRONG — belongs at ground
                                        and no ground wire drawn at all
```

The README said the right thing (9=red, 10=green, 11=blue, 220 Ω each). The picture contradicted it, and
the picture is what a person wires from.

**Cause:** `matchLeg` scored by word overlap. The model's free-form leg text *"green channel, via a
resistor to the common cathode"* shares TWO words with `common cathode (longest leg)` and only ONE with
`green anode`, so the cathode won.

**Fix, from the catalog's own data rather than a hardcoded rule:** a leg the catalog sends to GND/5V can
never be a SIGNAL destination, and leg assignment is INJECTIVE — two pins cannot claim one terminal.
Gate-locked in both directions: an RGB LED's three anodes must not split, three discrete LEDs must.

Verified after the fix — `PIN_9/10/11 → own 220Ω → own anode`, `common cathode → GND`.

### Finding 13 — `GND_RE` matched "GND" anywhere in a sentence, twice dangerously

Chasing "LDR leg B must reach GND" led to the catalog text: *"an analog pin, and also to one leg of a 10k
resistor whose other leg goes to GND"* — that is the SIGNAL leg. Anchoring the pattern to the start of
the destination phrase reclassified six catalog legs. Two were hazardous:

- `dc-motor-l298n-driver` 12V — *"an external 6-12V supply, **never the Arduino's 5V pin**"*
- `ws2812b-neopixel-strip` 5V — *"an external 5V power supply"*

The blunt rule would have drawn a wire from the Arduino's 5V pin to terminals the catalog explicitly
forbids. Generator and audit now share the anchored rule — they must agree, or the audit invents
failures the generator was right to avoid.

### Finding 14 — three discrete LEDs drawn as one component

Found by rendering traffic-light's diagram and looking at it: three signal wires converging on a single
`Standard LED` anode. Split proven from the catalog's leg list — a part with ONE driveable leg cannot be
driven by three pins. Conservative by design: it splits only when the leg count makes a single instance
impossible, because inventing a part that is not there is the worse error.

After: `PIN_2 → 220Ω → red anode → cathode → GND` ×3, three separate boxes, parts list deduped to
`Standard LED ×3`.

### Bugs 5-10 in the instruments

5. Stripping `_` turned `LED_BUILTIN` into `LEDBUILTIN`, so a README naming its pin read as having none.
6. A parent heading with subsections (`## Wiring` → `### RGB LED`) counted as empty.
7. Leg rectangles counted as components (10 for a 2-component project) — the discriminator is the
   trailing `{`, not the alias shape, and indentation is gone after `.trim()`.
8. The README pin scan read only the FIRST table cell, so `| RGB Red | 9 | PWM |` read as no pin map.
9. `| DHT DATA | Digital 2 |` read as a missing pin — the check demanded a bare number or the word "pin".
10. The mid-run guard's own `pgrep -f "dist/index.js -p"` matched the shell running it, so it refused to
    grade forever. **Third pgrep self-match of the session**; the first blocked a waiter for 20 minutes.

**Ten instrument bugs against fourteen in ayin.** Every one made the instrument harsher or plain wrong,
and each was a near-miss where "fixing" ayin would have made ayin worse. Hence the control: after every
tightening, re-audit a known-broken run and confirm it still fails.
