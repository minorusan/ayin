# ayin Arduino benchmark

Ten projects, escalating. Each is one prompt you hand ayin **in its own empty directory**, and a set
of checks that need no model to evaluate.

```bash
npm run bench:arduino                 # print the prompts + the traps each one sets
npm run bench:arduino -- grade <dir>  # grade every project found under <dir>
```

## Why this exists

*"ayin should be good at Arduino"* is not something you can act on. This turns it into a number that
moves: change a prompt, change the diagram renderer, change a QA criterion — rerun, see which way it
went.

## Why the traps are the point

Any model can emit a blink sketch. What separates a useful Arduino agent from a plausible one is a
small set of facts that are **invisible in the code and expensive in the world**:

- `analogWrite` on a pin with no hardware PWM compiles perfectly and gives you eight colours.
- An LED without a series resistor works right up until it doesn't.
- `delay()` in `loop()` makes a button unresponsive in a way that reads as a hardware fault.
- An LDR wired straight to an analog pin reads noise, because it is half a voltage divider.
- `pulseIn` without a timeout blocks for a full second when nothing is in front of the sensor.
- A WS2812B strip at full white pulls 1.8 A and browns out the board that is driving it.

Every project below is chosen for the traps it sets, and they escalate. The suite is not a test of
whether ayin can write C++; it is a test of whether ayin knows the things that cost you an evening.

## What is graded

All of it deterministic, none of it opinion:

| Check | How |
|---|---|
| the sketch compiles | real `arduino-cli`, real target board, temp build path |
| deliverables exist | sketch in a matching folder, README, `.wiring.puml`, `.wiring.svg` |
| the diagram parses | real `plantuml -syntax` |
| the diagram is grounded | the expected catalog components appear in it |
| `analogWrite` targets | only pins with hardware PWM on this board |
| the README is real | not the scaffold stub, no empty headings, long enough to hold a parts list |
| the traps | per-project `grep` / `notGrep` markers in the source |

Anything a reviewer would have to have an *opinion* about is deliberately absent. This measures the
floor, and the floor is where the expensive mistakes live.

## The projects

| # | Project | The thing it is really testing |
|---|---|---|
| 1 | Blink | honesty — there is no external component, and the diagram must say so |
| 2 | RGB cycle + button | PWM pins, per-channel resistors, non-blocking timing, debounce |
| 3 | Pedestrian crossing | a real state machine; `delay()` makes the button "not work" |
| 4 | Automatic night light | the LDR is half a voltage divider; 0–1023 is not 0–255 |
| 5 | Reaction timer | watching the button *during* the wait, not only after |
| 6 | Servo + potentiometer | `Servo.h` owns its pin and steals Timer1 (pins 9/10) |
| 7 | Parking sensor | `pulseIn` timing, the `/2` in the distance formula, passive vs active buzzer |
| 8 | Room climate display | two libraries that must be installed; I2C address varies by vendor; NaN reads |
| 9 | Eight-LED bar via 74HC595 | one resistor per output, latch discipline, MSB/LSB, OE/MR tied off-sketch |
| 10 | NeoPixel strip with modes | power budget, data-line resistor, no `delay()` anywhere |

Projects 8 and 10 are expected **not** to compile out of the box — they need third-party libraries.
What is graded there is whether ayin *told you which ones* before you found out.

## Running it

The runner does **not** drive ayin. Running the agent means GPU time on a shared card, and starting a
run is the operator's call. Print the prompts, run them yourself, then grade.
