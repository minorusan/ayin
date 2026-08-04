# The confirmation run — procedure

Written **before** the run, deliberately, so the standard cannot drift to fit the result.

Iterating until seven projects pass proves the fixes can work. It does not prove they *do* work, because
each fix was validated on the project that motivated it. A confirmation run answers the different and
harder question: **on frozen code, from empty directories, with no human in the loop, do all seven come
out right at once?**

## Rules

1. **Code is frozen.** No edit to `src/`, `prompts/`, or any `tool/` script from the moment the run
   starts until both tables are reported. Broken twice already this session — a mid-run rebuild means
   later projects test different code than earlier ones, which is not a measurement.
2. **Empty directories.** A fresh parent dir; one empty subdir per project. No leftovers from any prior
   attempt, or the run grades work it did not do.
3. **No hand-editing the output.** If a project comes out wrong, the fix goes into ayin and the run is
   *redone*, never patched. Patching the artifact would make the number meaningless.
4. **Both instruments, at their strictest.** `arduino-legit.mjs` (six build/doc conditions) **and**
   `arduino-wiring-audit.mjs` (nine electrical/cross-source checks). Passing one is not passing.
5. **The control must hold.** After the run, re-audit a known-broken earlier attempt. If the audit stops
   condemning `bench-run3`'s rgb-cycle, traffic-light and climate-display, then the tools went soft and
   the confirmation is void regardless of what it says.
6. **Report the failures.** If it is 6/7, that is the number. No rounding up, no "essentially working".

## Commands

```bash
# 1 · freeze check — nothing uncommitted-and-unbuilt
npm run build && npm run check:gates && npm run check:explore

# 2 · the run, from empty directories
rm -rf <CONFIRM_DIR>
tool/arduino-bench-run.sh <CONFIRM_DIR>   # all ten; the seven are graded

# 3 · both instruments
node tool/arduino-legit.mjs        <CONFIRM_DIR>
node tool/arduino-wiring-audit.mjs <CONFIRM_DIR>

# 4 · the control — this MUST still report failures
node tool/arduino-wiring-audit.mjs <PRIOR_BROKEN_DIR>
```

## What counts as passing

| | Requirement |
|---|---|
| legit | **7/7** — compiles, sketch named for its folder, README with parts + pin map + build commands and no TODO, `.wiring.puml` + `.svg` carrying the provenance stamp, PlantUML parses, no `analogWrite` on a dead pin |
| wiring | **7/7** — every driven pin drawn, no component unwired, every catalog-required series part in the wire, rail legs reaching their rail, no two pins on one leg, no dangling series part, `INPUT_PULLUP` with a ground path, I2C on A4/A5, README pins == code pins |
| control | the prior broken run still fails |

Anything less is reported as what it is.

## Why the control matters

Eight of the bugs found this session were in these tools, not in ayin: headings counted inside code
fences, then fences stripped so a fenced section read as empty, a pin map failed for being a table, `_`
stripped so `LED_BUILTIN` became `LEDBUILTIN`, a parent heading with subsections called empty, leg
rectangles counted as components, `| 1 | Arduino Uno |` mistaken for a pin map, and a `GND` keyword
matched anywhere in a sentence — the last of which would have had the generator wire the Arduino's 5V
pin to a terminal the catalog says must come from an external supply.

Every one of those made the instrument *harsher* or *wronger*, and each was a near-miss where "fixing"
ayin would have made ayin worse. A tightening that is not followed by re-running the control is a
tightening on trust.
