/**
 * arduino-components-data — the shipped reference catalog for `arduino-db` / `/arduino-explain`.
 *
 * A plain data module, not a database or a RAG index — just the broad, common starter-kit parts a
 * beginner actually hits, written for a beginner (see `docs/ARCHITECTURE.md` § arduino-db). Content
 * authored by two independent LLM passes (inputs/sensors/passive · outputs/displays/comms) split so
 * neither had to cover the other's ground, then reviewed for schema consistency.
 *
 * Adding a component: append one `ArduinoComponent` with a unique kebab-case `id`. `category` drives
 * which fallback symbol `arduino-explain.ts` draws when no id-specific icon exists, so pick the closest
 * of the six even for a component that doesn't fit neatly.
 */

export interface ArduinoLeg {
  /** e.g. "anode (long leg, +)", "VCC", "top-left leg" — physical, not electrical jargon alone. */
  legName: string;
  /** What it wires to, generically (project-specific pin numbers come from the grounding LLM call). */
  connectsTo: string;
  /** One short clause on WHY — the thing a beginner actually needs to not wire it backwards. */
  explanation: string;
}

export type ArduinoCategory = 'input' | 'sensor' | 'passive' | 'output' | 'display' | 'communication';

export interface ArduinoComponent {
  id: string;
  name: string;
  aliases: string[];
  category: ArduinoCategory;
  /** How a beginner spots this specific part in a pile of loose components from a kit. */
  identify: string;
  whatItDoes: string;
  /** How it's actually driven from a sketch — functions, library, digital/analog/PWM/I2C, gotchas. */
  howUsed: string;
  legs: ArduinoLeg[];
  /** The single most important wiring gotcha — resistor value, polarity, external power, etc. */
  wiringNotes: string;
}

export const ARDUINO_COMPONENTS: ArduinoComponent[] = [
  {
    id: 'push-button',
    name: 'Push Button (4-leg tactile switch)',
    aliases: ['button', 'tact switch', 'tactile switch', 'push switch', 'momentary switch', '4-pin button'],
    category: 'input',
    identify: "A small square or rectangular plastic block, usually blue, black, or red, about the size of a pencil eraser, with a round button cap on top and 4 metal legs poking straight down from the bottom in a square pattern. It's sized to straddle the center gap of a breadboard, with two legs on the left edge and two on the right edge.",
    whatItDoes: "It's a simple switch you press with your finger. While held down it connects a circuit; when released, the circuit is open again.",
    howUsed: "Wire one side to a digital pin and the other side to GND, then use `pinMode(pin, INPUT_PULLUP)` so the pin reads HIGH when not pressed and LOW when pressed — this avoids needing an extra resistor. Read the state with `digitalRead(pin)`. The classic beginner gotcha is 'bounce': a mechanical button flickers HIGH/LOW several times in the first few milliseconds of a press, so sketches that count presses need a short debounce delay (e.g. ignore changes for 20-50ms) or they'll count one press as several.",
    legs: [
      { legName: 'top-left leg', connectsTo: 'a digital pin (same node as bottom-left leg)', explanation: 'one terminal of the switch; the two left legs are internally joined and only exist in a pair for mechanical stability' },
      { legName: 'bottom-left leg', connectsTo: 'same digital pin as top-left leg, or left unconnected', explanation: 'internally shorted to the top-left leg, so wiring only one is enough' },
      { legName: 'top-right leg', connectsTo: 'GND (same node as bottom-right leg)', explanation: 'the other terminal; pressing the button bridges this side to the left side' },
      { legName: 'bottom-right leg', connectsTo: 'GND, same as top-right leg, or left unconnected', explanation: 'internally shorted to the top-right leg' },
    ],
    wiringNotes: "Straddle the breadboard's center gap so the left-side pair and right-side pair land in separate rows — placed the wrong way, all 4 legs end up in the same row and the button reads as permanently 'pressed'. Use INPUT_PULLUP to skip an external resistor entirely; if you instead wire it to 5V, you must add a 10k pull-down resistor to GND or the pin will float randomly when not pressed.",
  },
  {
    id: 'potentiometer',
    name: 'Potentiometer (rotary, 3-leg)',
    aliases: ['pot', 'trim pot', 'trimmer', 'variable resistor', 'dial', 'knob'],
    category: 'input',
    identify: 'A small cylindrical or rectangular component with a knob or a flat screwdriver-adjustable slot on top that turns, and 3 legs in a row underneath. Kit versions are often blue plastic squares (trimmer pots, adjusted with a tiny screwdriver) or larger black cylinders with a plastic knob you turn by hand.',
    whatItDoes: "It's a dial that changes a resistance value as you turn it, letting you feed the Arduino a variable, human-adjustable value — like a volume knob.",
    howUsed: "Read it with `analogRead(pin)` on the middle leg, which returns a value from 0-1023 as the knob turns from one end to the other. It's a purely analog input — no library needed. A common beginner mix-up is treating it like a fixed resistor; the two outer legs always connect straight to power and ground, only the middle leg (the wiper) goes to the Arduino.",
    legs: [
      { legName: 'left outer leg', connectsTo: '5V (or GND)', explanation: 'one end of the internal resistive track' },
      { legName: 'middle leg (wiper)', connectsTo: 'an analog input pin', explanation: 'taps a voltage between the two ends that changes as the knob turns' },
      { legName: 'right outer leg', connectsTo: 'GND (or 5V)', explanation: 'the other end of the internal resistive track, completing the divider' },
    ],
    wiringNotes: 'The two outer legs must go to 5V and GND (either way round) — swapping them just reverses which direction increases the reading. Never connect the middle leg directly to 5V or GND; it should only ever go to the analog pin.',
  },
  {
    id: 'photoresistor-ldr',
    name: 'Photoresistor / LDR (light-dependent resistor)',
    aliases: ['LDR', 'light sensor', 'photocell', 'CdS cell', 'light dependent resistor'],
    category: 'sensor',
    identify: "A small flat disc, usually orange, yellowish, or reddish-brown, about the size of a shirt button, with a shiny, squiggly zig-zag track visible on its face under a clear coating. It has 2 straight legs coming out the bottom, no markings to speak of, and looks nothing like a battery or LED — it's flat and disc-shaped, not domed.",
    whatItDoes: 'It changes its resistance based on how much light is hitting it — bright light lowers the resistance, darkness raises it.',
    howUsed: 'It has no polarity and must be paired with a fixed resistor (commonly 10k) to form a voltage divider before the Arduino can read it — read the midpoint of the divider with `analogRead(pin)`. Beginners often connect it alone expecting a direct light reading, but on its own it only changes resistance; it needs the partner resistor to turn that into a voltage the analog pin can measure.',
    legs: [
      { legName: 'leg A (no polarity)', connectsTo: '5V', explanation: 'feeds current into the divider' },
      { legName: 'leg B (no polarity)', connectsTo: "an analog pin, and also to one leg of a 10k resistor whose other leg goes to GND", explanation: 'the LDR and the 10k resistor form a voltage divider; the analog pin reads the voltage at their junction, which shifts with light level' },
    ],
    wiringNotes: "Requires a partner resistor (~10k) to work at all — it is never wired alone. Swapping the LDR and resistor's positions in the divider flips whether the analogRead value goes up or down with brightness, so if your logic seems backwards, that's usually why.",
  },
  {
    id: 'thermistor',
    name: 'Thermistor (analog temperature sensor, NTC)',
    aliases: ['temp sensor', 'NTC', 'NTC thermistor', 'temperature resistor', 'thermal resistor'],
    category: 'sensor',
    identify: "A tiny bead or disc, usually blue, green, or black epoxy-coated, roughly the size of a small bead or lentil, with 2 thin wire legs sticking out the bottom — it looks a bit like an LED that's missing its clear dome, or a miniature capacitor. No lens, no dome, no printed component code, just a small coated blob with two wires.",
    whatItDoes: 'It changes its resistance based on temperature — as it gets warmer, its resistance drops (for the common NTC type).',
    howUsed: 'Like the LDR, it has no polarity and needs a fixed resistor (often 10k, matched to the thermistor\'s rated resistance) to form a voltage divider so `analogRead(pin)` can measure it. Converting the raw analogRead number into an actual temperature in Celsius requires a formula (the Steinhart-Hart equation, or a simplified beta-value version) — a common beginner mistake is treating the raw analogRead number itself as degrees, which it is not.',
    legs: [
      { legName: 'leg 1 (no polarity)', connectsTo: '5V', explanation: 'feeds current into the divider' },
      { legName: 'leg 2 (no polarity)', connectsTo: 'an analog pin, and also one leg of a 10k resistor whose other leg goes to GND', explanation: 'forms a voltage divider so the changing resistance becomes a changing voltage the analog pin can read' },
    ],
    wiringNotes: 'Needs a partner resistor to form a divider, just like the LDR — never wired alone. The raw analogRead value is not a temperature; it must be converted using a temperature formula, usually with constants specific to the thermistor\'s datasheet.',
  },
  {
    id: 'pir-motion-sensor-hc-sr501',
    name: 'PIR Motion Sensor Module (HC-SR501)',
    aliases: ['PIR sensor', 'motion sensor', 'HC-SR501', 'passive infrared sensor', 'motion detector module'],
    category: 'sensor',
    identify: 'A small green or blue circuit board topped with a round, white, dome-shaped plastic lens (a Fresnel lens) that looks like half a ping-pong ball or a tiny UFO. On the back of the board are two small blue trimmer potentiometers (adjustment dials) and a small 3-pin jumper cap. It has a 3-pin header labeled VCC, OUT (or SIG), and GND.',
    whatItDoes: 'It detects movement of warm bodies (like a person walking by) by sensing changes in infrared heat within its field of view.',
    howUsed: "Read it with `digitalRead(pin)` on the OUT pin — it goes HIGH when motion is detected and LOW (or stays HIGH briefly, depending on the delay setting) otherwise. The two onboard trimpots adjust sensitivity (detection distance) and the output delay time (how long OUT stays HIGH after triggering). A key beginner gotcha: the sensor needs 30-60 seconds to 'warm up' and stabilize after power-on, during which it may fire false triggers — ignore its output during that startup window.",
    legs: [
      { legName: 'VCC', connectsTo: '5V', explanation: "powers the sensor's onboard circuitry" },
      { legName: 'OUT', connectsTo: 'a digital pin', explanation: 'goes HIGH when motion is detected, LOW otherwise' },
      { legName: 'GND', connectsTo: 'GND', explanation: 'completes the power circuit' },
    ],
    wiringNotes: "Give it 30-60 seconds after power-up before trusting its readings — it will often false-trigger while settling. The two trimpots (sensitivity and delay) directly change behavior, so if a tutorial's timing doesn't match yours, check the dial positions first.",
  },
  {
    id: 'ultrasonic-distance-sensor-hc-sr04',
    name: 'Ultrasonic Distance Sensor (HC-SR04)',
    aliases: ['ultrasonic sensor', 'distance sensor', 'HC-SR04', 'sonar sensor', 'ping sensor'],
    category: 'sensor',
    identify: "A small rectangular blue or green circuit board with two large shiny metal cylinders ('eyes') mounted side by side on the front, each about the size of a large button, looking like a tiny robot's face. It has a 4-pin header labeled VCC, Trig, Echo, and GND.",
    whatItDoes: "It measures distance to an object by sending out an ultrasonic 'chirp' (sound too high-pitched for humans to hear) and timing how long the echo takes to bounce back.",
    howUsed: 'Send a short HIGH pulse (about 10 microseconds) on the Trig pin with `digitalWrite`, then measure the return pulse width on the Echo pin using `pulseIn(echoPin, HIGH)`, which returns the round-trip time in microseconds. Convert that to distance with roughly `distance_cm = duration * 0.034 / 2`. A common gotcha: it needs a brief `delayMicroseconds` low-then-high sequence on Trig to fire reliably, and it struggles with soft/angled surfaces that absorb or deflect sound.',
    legs: [
      { legName: 'VCC', connectsTo: '5V', explanation: 'powers the two transducers and onboard logic' },
      { legName: 'Trig', connectsTo: 'a digital pin (output)', explanation: 'Arduino pulses this pin HIGH briefly to fire the ultrasonic chirp' },
      { legName: 'Echo', connectsTo: 'a digital pin (input)', explanation: 'goes HIGH for the duration the sound wave took to return, measured with pulseIn' },
      { legName: 'GND', connectsTo: 'GND', explanation: 'completes the circuit' },
    ],
    wiringNotes: 'Trig and Echo are two separate pins (unlike some single-pin ultrasonic sensors) — mixing them up is the most common wiring mistake. It runs fine on 5V logic, so no level-shifting is needed with an Uno.',
  },
  {
    id: 'ir-receiver-module',
    name: 'IR Receiver Module (VS1838B / KY-022)',
    aliases: ['IR sensor', 'infrared receiver', 'VS1838B', 'KY-022', 'remote control receiver', 'IR module'],
    category: 'sensor',
    identify: 'A small, dark bluish-black component shaped like a tiny bullet or dome with a flat front face, about the size of a pencil eraser tip, with 3 legs coming out the bottom — resembles a small transistor. On a breakout module, it\'s mounted upright on a small board with a 3-pin header.',
    whatItDoes: 'It detects infrared light pulses from a remote control (like a TV remote) and outputs a digital signal that a library can decode into button-press codes.',
    howUsed: "Use a library like `IRremote` — attach the OUT/signal pin as a digital input, call `irrecv.decode()` in a loop, and it converts the raw IR flicker pattern into a recognizable code for each remote button. A common beginner gotcha is pin order: unlike most 3-leg parts, the pinout (VCC/GND/OUT order) varies between manufacturers, so always check the part's printed markings or datasheet rather than assuming.",
    legs: [
      { legName: 'OUT (signal)', connectsTo: 'a digital pin', explanation: 'outputs a decodable digital pattern whenever it detects IR light pulses' },
      { legName: 'GND', connectsTo: 'GND', explanation: 'completes the circuit' },
      { legName: 'VCC', connectsTo: '5V (check datasheet — some variants use 3.3V)', explanation: 'powers the internal IR demodulator chip' },
    ],
    wiringNotes: 'Double-check the leg order against the specific part\'s datasheet or silkscreen before wiring — it is not standardized across brands, and reversing VCC/GND can damage the part. It needs an actual IR remote to test against; pointing a TV remote at it and pressing buttons is the easiest first test.',
  },
  {
    id: 'tilt-switch',
    name: 'Tilt Switch / Ball Switch (2-leg)',
    aliases: ['ball switch', 'tilt sensor', 'vibration switch', 'tilt ball switch', 'mercury switch look-alike'],
    category: 'input',
    identify: "A small metal cylinder about the size of a pencil eraser or a large capacitor, with 2 wire legs coming out one end. Shake it gently near your ear and you'll hear a tiny metal ball rattling around inside — that rattle is the giveaway that distinguishes it from a capacitor or diode of similar size.",
    whatItDoes: "It's a switch that turns on or off depending on which way it's tilted — a metal ball inside rolls to touch (or leave) two internal contacts as the orientation changes.",
    howUsed: "Wire it exactly like a push button: one leg to a digital pin, the other to GND, using `pinMode(pin, INPUT_PULLUP)` and `digitalRead(pin)`. The beginner gotcha is expecting smooth analog tilt detection — it's a simple binary on/off switch, not a tilt angle sensor, and it can 'bounce' briefly as the ball settles, same as a mechanical button.",
    legs: [
      { legName: 'leg 1 (no polarity)', connectsTo: 'a digital pin', explanation: 'one terminal; connects to the other leg only when the ball is resting on the contacts in the current orientation' },
      { legName: 'leg 2 (no polarity)', connectsTo: 'GND', explanation: 'completes the circuit when the internal ball bridges the contacts' },
    ],
    wiringNotes: 'Use INPUT_PULLUP just like a push button — no external resistor needed. It only reports two states based on orientation (tilted this way vs. that way), not a continuous angle, and mounting orientation on your project matters a lot for it to trigger reliably.',
  },
  {
    id: 'rotary-encoder-ky-040',
    name: 'Rotary Encoder Module (KY-040)',
    aliases: ['encoder module', 'rotary encoder', 'KY-040', 'encoder knob', 'quadrature encoder'],
    category: 'input',
    identify: 'A small square breakout board with a metal shaft sticking up through the center, topped with a knurled plastic knob (often blue or black) that spins freely and clicks slightly as it turns. Unlike a potentiometer knob, it can spin continuously in either direction with no end stop, and it can also be pressed straight down like a button. It has a 5-pin header: CLK, DT, SW, +, and GND.',
    whatItDoes: 'It reports which direction and how many steps it was turned (like a volume knob that clicks), and it also has a built-in push-button you activate by pressing the knob down.',
    howUsed: "Watch the CLK pin with `attachInterrupt` (or poll it fast in `loop()`) and, each time it changes, check the DT pin's state to determine direction — this pair (CLK/DT) forms a quadrature signal. The SW pin is just a normal momentary switch, read with `digitalRead` and `INPUT_PULLUP`. The common beginner gotcha is missed steps: polling too slowly in `loop()` causes skipped or double-counted clicks, which is why interrupts are recommended for CLK.",
    legs: [
      { legName: 'CLK', connectsTo: 'a digital pin (ideally interrupt-capable)', explanation: 'toggles as the knob turns; used with DT to determine rotation direction' },
      { legName: 'DT', connectsTo: 'a digital pin', explanation: "its state relative to CLK at each transition tells you which way the knob turned" },
      { legName: 'SW', connectsTo: 'a digital pin', explanation: 'a plain momentary switch triggered by pressing the knob straight down' },
      { legName: '+', connectsTo: '5V', explanation: "powers the encoder's internal contacts" },
      { legName: 'GND', connectsTo: 'GND', explanation: 'completes the circuit' },
    ],
    wiringNotes: "SW needs the same pull-up handling as any push button (`INPUT_PULLUP` or an external pull-down). For smooth, non-skipping rotation counting, put CLK on an interrupt-capable pin rather than relying on plain polling in `loop()`.",
  },
  {
    id: 'dht11-dht22-temp-humidity-sensor',
    name: 'DHT11 / DHT22 Temperature + Humidity Sensor Module',
    aliases: ['DHT11', 'DHT22', 'temperature humidity sensor', 'humidity sensor', 'DHT module'],
    category: 'sensor',
    identify: 'A small rectangular plastic-cased module, blue for DHT11 or white for DHT22, with a grid of small vent slats on the front face where the sensing element sits. On a breakout board it has just 3 pins (VCC, OUT/DATA, GND) with a small extra component (a resistor) visible on the back; the bare 4-pin sensor (no breakout board) looks the same but needs its own external pull-up resistor.',
    whatItDoes: 'It measures both air temperature and humidity at the same time and reports both as numbers.',
    howUsed: "Use a library like the Adafruit `DHT` library or `SimpleDHT` — call something like `dht.readTemperature()` and `dht.readHumidity()` on a single digital pin. The big beginner gotcha: it's slow and must not be read more than about once every 1-2 seconds (DHT22) or it returns garbage/NaN; also the bare 4-pin sensor (not the 3-pin module) needs an external ~10k pull-up resistor on the data line, which the module version already includes onboard.",
    legs: [
      { legName: 'VCC', connectsTo: '5V', explanation: 'powers the sensing element and its logic chip' },
      { legName: 'OUT / DATA / S', connectsTo: 'a digital pin', explanation: 'sends temperature and humidity as a timed digital signal read by the DHT library' },
      { legName: 'GND', connectsTo: 'GND', explanation: 'completes the circuit' },
    ],
    wiringNotes: "Don't poll it faster than about once per second (DHT11) or once every 2 seconds (DHT22) — it will return invalid readings if rushed. If using the bare sensor instead of the 3-pin module, remember to add your own pull-up resistor on the data line.",
  },
  {
    id: 'sound-detection-sensor-ky-038',
    name: 'Sound Detection Sensor Module (KY-038)',
    aliases: ['microphone module', 'sound sensor', 'KY-038', 'mic sensor', 'clap sensor'],
    category: 'sensor',
    identify: 'A small circuit board with a round, silver, metal-canned microphone capsule mounted on it (looks like a tiny drum or coin), plus a small blue trimmer potentiometer (adjustment screw) and often a tiny LED nearby. It has a 4-pin header labeled VCC, GND, DO, and AO.',
    whatItDoes: "It listens for sound and can report either a raw loudness signal or a simple yes/no 'sound detected' trigger once volume crosses a threshold.",
    howUsed: "Use `digitalRead(pin)` on DO for a simple threshold trigger (e.g. detect a clap or loud noise) — the trigger loudness is tuned with the onboard trimpot, a very common thing beginners forget to adjust when it seems 'unresponsive.' Use `analogRead(pin)` on AO to get the raw fluctuating waveform level if you want actual loudness detail rather than a simple trigger.",
    legs: [
      { legName: 'VCC', connectsTo: '5V', explanation: 'powers the microphone amplifier and comparator circuit' },
      { legName: 'GND', connectsTo: 'GND', explanation: 'completes the circuit' },
      { legName: 'DO', connectsTo: 'a digital pin', explanation: 'flips state when sound volume crosses the threshold set by the onboard trimpot' },
      { legName: 'AO', connectsTo: 'an analog pin', explanation: 'outputs a continuously varying signal proportional to sound level' },
    ],
    wiringNotes: "If DO never seems to trigger (or triggers constantly), turn the onboard trimpot with a small screwdriver to adjust sensitivity before assuming the code is wrong — this is the single most common issue beginners hit with this module.",
  },
  {
    id: 'soil-moisture-sensor-module',
    name: 'Soil Moisture Sensor Module (2-prong + comparator board)',
    aliases: ['moisture sensor', 'soil sensor', 'hygrometer module', 'plant sensor', 'soil hygrometer'],
    category: 'sensor',
    identify: "Two parts connected by a short wire cable: a long, narrow PCB 'fork' with two exposed gold or copper prongs at one end (meant to be pushed into soil), and a separate small blue circuit board (with a trimmer potentiometer and small LED) that the fork's cable plugs into. The small board has a 4-pin header: VCC, GND, DO, AO.",
    whatItDoes: 'It measures how much moisture is in soil by checking how well electricity conducts between its two exposed metal prongs — wetter soil conducts better.',
    howUsed: "Use `analogRead(pin)` on AO for a graded moisture reading (lower value usually means wetter soil, but calibrate it yourself — there's no universal number), or `digitalRead(pin)` on DO for a simple wet/dry threshold tuned by the board's trimpot. The key beginner gotcha: leaving it powered continuously in soil causes the exposed prongs to corrode over time from electrolysis, so many projects only power it briefly right before each reading.",
    legs: [
      { legName: 'VCC', connectsTo: '5V (or a digital pin used as a switched power source)', explanation: 'powers the probe; switching this on only during a reading reduces prong corrosion' },
      { legName: 'GND', connectsTo: 'GND', explanation: 'completes the circuit' },
      { legName: 'DO', connectsTo: 'a digital pin', explanation: 'flips state when moisture crosses the threshold set by the onboard trimpot' },
      { legName: 'AO', connectsTo: 'an analog pin', explanation: 'gives a graded reading of soil conductivity/moisture level' },
    ],
    wiringNotes: "Don't leave the probe powered continuously long-term — the exposed prongs corrode faster with constant current, so power it only when taking a reading if the project runs for weeks. There's no fixed 'wet' or 'dry' number; calibrate the analog reading against your own soil and pot.",
  },
  {
    id: 'reed-switch',
    name: 'Reed Switch (magnetic proximity switch, 2-leg)',
    aliases: ['magnetic switch', 'reed sensor', 'proximity switch', 'magnet switch'],
    category: 'sensor',
    identify: 'A thin glass tube, about the size of a matchstick or smaller, with 2 thin wire legs coming out either end (not both from the same side, unlike most other 2-leg parts). No rattling sound when shaken — that\'s what tells it apart from a tilt/ball switch. Two thin metal strips are visible inside the glass if you look closely.',
    whatItDoes: 'It\'s a switch that closes only when a magnet is held near it — no physical contact or tilting needed, just magnetic proximity (used in things like door/window alarm sensors).',
    howUsed: "Wire it exactly like a push button — one leg to a digital pin, the other to GND — using `pinMode(pin, INPUT_PULLUP)` and `digitalRead(pin)`. The beginner gotcha is confusing it with the tilt switch: a reed switch responds to a nearby magnet regardless of orientation, and does nothing at all without one nearby, whereas a tilt switch responds to orientation and needs no magnet.",
    legs: [
      { legName: 'leg 1 (no polarity)', connectsTo: 'a digital pin', explanation: 'one terminal; the internal reed contacts close only when a magnet is nearby' },
      { legName: 'leg 2 (no polarity)', connectsTo: 'GND', explanation: 'completes the circuit whenever the reed contacts close' },
    ],
    wiringNotes: 'It does nothing without a magnet held near the glass tube — test it by moving a small magnet close rather than assuming the part or wiring is faulty. The glass body is fragile; avoid bending the legs right at the glass seam.',
  },
  {
    id: 'resistor',
    name: 'Resistor (fixed, through-hole, color-band)',
    aliases: ['fixed resistor', 'color band resistor', 'carbon resistor', 'resistor assortment'],
    category: 'passive',
    identify: 'A small cylinder, usually tan, beige, or blue, about the size of a grain of rice to a small pea, with 2 straight wire legs coming out either end and a series of 4-5 colored stripes painted around its body — this color-band pattern is the single biggest giveaway distinguishing it from every other loose part in a kit.',
    whatItDoes: 'It limits how much electric current can flow through a circuit, protecting other components (especially LEDs) from getting too much current and burning out.',
    howUsed: "It's not read or controlled by code at all — it's a passive part placed in series (or as part of a divider) in the physical circuit, most commonly to protect an LED or to form a voltage divider with a sensor like an LDR or thermistor. The color bands encode its resistance value in ohms (a color code chart or a multimeter tells you which value you're holding), and a common beginner mistake is grabbing the wrong value resistor because the bands weren't checked.",
    legs: [
      { legName: 'leg 1 (no polarity)', connectsTo: 'one point in the circuit (e.g. a digital pin or power rail)', explanation: 'either leg can go on either side — resistors have no polarity' },
      { legName: 'leg 2 (no polarity)', connectsTo: 'another point in the circuit (e.g. an LED leg or GND)', explanation: "completes the current-limiting path; direction doesn't matter" },
    ],
    wiringNotes: 'Resistors have no polarity, so they can be inserted either way round. Always check the color bands (or measure with a multimeter) before using one — a resistor with too low a value in an LED circuit can let through enough current to damage the LED or the Arduino pin.',
  },
  {
    id: 'standard-led',
    name: 'Standard LED (single color, through-hole)',
    aliases: ['LED', 'light emitting diode', '5mm LED', '3mm LED', 'indicator LED'],
    category: 'output',
    identify: 'A small clear or tinted plastic dome (usually 5mm or 3mm across) with two thin wire legs sticking out the bottom, one noticeably longer than the other. Look at the base of the dome: one side has a flat edge cut into the plastic rim, which lines up with the shorter leg.',
    whatItDoes: 'It lights up when electricity flows through it in one direction only, turning electrical current into light.',
    howUsed: "Drive it with digitalWrite(pin, HIGH) on a digital pin to turn it fully on/off, or analogWrite(pin, value) on a PWM-capable pin to fade its brightness. The most common beginner mistake is wiring it without a current-limiting resistor, which lets too much current flow and burns the LED out almost instantly.",
    legs: [
      { legName: 'anode (long leg, +)', connectsTo: 'a digital or PWM pin through a 220Ω resistor', explanation: "the resistor limits current so the LED isn't damaged" },
      { legName: 'cathode (short leg, flat side, -)', connectsTo: 'Arduino GND', explanation: 'current only flows one way through an LED, so polarity matters' },
    ],
    wiringNotes: "Always use a resistor (about 220Ω-330Ω for 5V) in series; wiring it backwards just means it won't light, it won't damage it at 5V, but skipping the resistor will.",
  },
  {
    id: 'rgb-led-common-cathode',
    name: 'RGB LED (common-cathode, 4-leg)',
    aliases: ['RGB LED', 'tricolor LED', '4-pin LED', 'common cathode RGB LED', 'color-mixing LED'],
    category: 'output',
    identify: 'Looks like a slightly larger, often clear/water-clear 5mm LED dome, but with four legs instead of two. One leg (usually the longest) sits in the middle or second position; the other three are evenly spaced around it.',
    whatItDoes: "It's really three LEDs (red, green, blue) built into one bulb, sharing one ground leg, so mixing the three colors' brightness lets you make almost any color.",
    howUsed: "Use analogWrite() on three separate PWM pins, one per color channel, each through its own resistor, and vary the values 0-255 to mix colors. Beginner gotcha: this component is common-cathode (all three colors turn ON with HIGH); a common-anode version exists too and needs the opposite logic, so mixing the two up gives an LED that appears 'stuck' or inverted.",
    legs: [
      { legName: 'red anode', connectsTo: 'a PWM pin through a ~220Ω resistor', explanation: 'drives the red channel independently' },
      { legName: 'common cathode (longest leg)', connectsTo: 'Arduino GND', explanation: 'shared return path for all three color channels' },
      { legName: 'green anode', connectsTo: 'a PWM pin through a ~220Ω resistor', explanation: 'drives the green channel independently' },
      { legName: 'blue anode', connectsTo: 'a PWM pin through a ~150-220Ω resistor', explanation: 'blue (and often green) LEDs drop more voltage so may want a slightly lower resistor for balanced brightness' },
    ],
    wiringNotes: 'Identify the common leg (usually the longest) before wiring anything else — get it wrong and none of the colors will light correctly; each color leg still needs its own resistor, not just one shared one.',
  },
  {
    id: 'piezo-buzzer',
    name: 'Piezo buzzer (passive or active, 2-pin)',
    aliases: ['buzzer', 'piezo speaker', 'piezo element', 'beeper', 'sound module'],
    category: 'output',
    identify: "A small round metal disc, usually black or silver, about 12-14mm across, mounted in a squat plastic case with two pins or two wire legs sticking out the bottom. Some are marked with a small '+' near one pin; many look identical whether active or passive.",
    whatItDoes: 'It makes sound by vibrating a thin metal disc when you send it an electrical signal.',
    howUsed: "An active buzzer just needs digitalWrite(pin, HIGH) to make a fixed-pitch beep. A passive buzzer needs the tone(pin, frequency) / noTone(pin) functions to generate a variable-pitch sound or melody — driving a passive buzzer with plain digitalWrite only produces a faint click, not a tone. Since the two types look alike, if tone() doesn't work as expected, try plain HIGH/LOW to check which type you actually have.",
    legs: [
      { legName: 'positive lead (often marked +)', connectsTo: 'a digital pin (directly for small active buzzers, or through a transistor for louder ones)', explanation: 'carries the driving signal or voltage that makes it vibrate' },
      { legName: 'negative lead', connectsTo: 'Arduino GND', explanation: 'completes the circuit' },
    ],
    wiringNotes: 'Polarity usually doesn\'t matter much for tone quality but connecting it backwards can cause weaker sound on some active buzzers; no resistor is needed for a basic 5V hookup.',
  },
  {
    id: 'sg90-micro-servo',
    name: 'Micro servo motor (SG90, 3-wire)',
    aliases: ['SG90', 'micro servo', 'servo motor', '9g servo', 'hobby servo'],
    category: 'output',
    identify: "A small blue-and-white (or black-and-white) plastic box roughly the size of a matchbox, with a white plastic gear (the 'horn') sticking out the top and a single 3-wire cable coming out one side ending in a small female connector.",
    whatItDoes: "It's a small motor that rotates its arm to an exact angle you tell it, and holds that position, instead of spinning continuously like a normal motor.",
    howUsed: "Use the Servo.h library: myServo.attach(pin) then myServo.write(angle) with an angle from 0-180. It needs a PWM-capable pin for the signal wire. Beginner gotcha: powering it from the Arduino's onboard 5V pin can brown out the board when the servo moves under load or stalls — use an external 5-6V supply (with a shared ground) for anything beyond a quick single-servo test.",
    legs: [
      { legName: 'signal (orange or yellow wire)', connectsTo: 'a PWM-capable digital pin', explanation: 'carries the pulse that tells the servo what angle to move to' },
      { legName: 'power (red wire)', connectsTo: '5V, ideally from an external 5-6V supply rather than the Arduino\'s onboard 5V pin', explanation: "servos can draw brief current spikes that a small onboard regulator can't safely supply" },
      { legName: 'ground (brown or black wire)', connectsTo: "Arduino GND (and the external supply's GND, if used)", explanation: 'all grounds must be shared for the signal to be read correctly' },
    ],
    wiringNotes: 'The most common beginner failure is powering it straight from the Arduino board — it can work briefly but resets the Arduino when the servo strains; use a separate power supply for anything real.',
  },
  {
    id: 'dc-motor-l298n-driver',
    name: 'DC motor + L298N motor driver module',
    aliases: ['L298N', 'H-bridge module', 'motor driver board', 'TT motor', 'dual H-bridge', 'DC gear motor'],
    category: 'output',
    identify: "The motor is a small cylinder (metal or plastic) with two bare wire leads or metal tabs, sometimes attached to a yellow plastic gearbox (a 'TT motor'). The L298N driver is a distinctive red or blue PCB with a large black chip topped by a silver heatsink, blue screw terminals along the edges, and a small black voltage-regulator chip.",
    whatItDoes: "The motor spins a shaft to create movement; the L298N module sits between the Arduino and the motor so the Arduino's weak signal pins can control a motor that needs much more current and can spin it in either direction.",
    howUsed: "Set two digital pins (IN1/IN2) HIGH/LOW in combination to choose spin direction, and use analogWrite() on the enable pin (ENA) for PWM speed control. The motor's own power (6-12V) must come from a separate battery/supply connected to the module's screw terminals — it cannot be run from the Arduino's 5V pin. Common gotcha: forgetting to connect the external supply's ground to the Arduino's ground, which makes the direction/speed control unreliable.",
    legs: [
      { legName: 'OUT1/OUT2 (motor terminals)', connectsTo: 'the two wires of the DC motor', explanation: 'the module reverses current through these to control spin direction' },
      { legName: 'ENA (enable A)', connectsTo: 'a PWM pin on the Arduino', explanation: 'controls motor speed via PWM duty cycle' },
      { legName: 'IN1', connectsTo: 'a digital pin on the Arduino', explanation: 'together with IN2, sets spin direction' },
      { legName: 'IN2', connectsTo: 'a digital pin on the Arduino', explanation: 'together with IN1, sets spin direction' },
      { legName: '12V/VCC (motor power screw terminal)', connectsTo: "an external 6-12V supply, never the Arduino's 5V pin", explanation: 'the motor needs more current and often more voltage than the Arduino can supply' },
      { legName: 'GND', connectsTo: "Arduino GND and the external supply's GND, tied together", explanation: 'shared ground lets the control signals be read correctly' },
    ],
    wiringNotes: "Never power the motor from the Arduino's 5V line; use a separate battery pack on the module's power terminals and always tie its ground to the Arduino's ground.",
  },
  {
    id: 'relay-module-5v',
    name: '5V relay module (single channel)',
    aliases: ['relay board', '5V relay', 'Songle relay module', 'SRD-05VDC relay', 'single channel relay'],
    category: 'output',
    identify: "A small PCB (often blue or red) with one blue rectangular component labeled 'SONGLE' or similar on top, a 3-pin header on one side (VCC/GND/IN), and a set of three screw terminals on the other side, often labeled COM, NO, and NC.",
    whatItDoes: "It's an electrically controlled switch: a small signal from the Arduino flips an internal mechanical switch that can turn a completely separate, much higher-power circuit on or off.",
    howUsed: "digitalWrite(pin, HIGH) or LOW on the IN pin switches the relay. Important gotcha: many low-cost modules are 'active-LOW', meaning LOW actually turns the relay ON — always test with a simple sketch first rather than assuming HIGH means on.",
    legs: [
      { legName: 'VCC', connectsTo: 'Arduino 5V', explanation: "powers the module's onboard logic and coil driver" },
      { legName: 'GND', connectsTo: 'Arduino GND', explanation: 'completes the control-side circuit' },
      { legName: 'IN (signal)', connectsTo: 'a digital pin on the Arduino', explanation: 'HIGH/LOW here switches the relay (check if active-high or active-low)' },
      { legName: 'COM (screw terminal)', connectsTo: 'the shared/hot wire of the external circuit being switched', explanation: 'this is the terminal the relay connects or disconnects' },
      { legName: 'NO — normally open (screw terminal)', connectsTo: "the external device's wire, if it should turn ON when the relay activates", explanation: 'this path is open until the relay energizes' },
      { legName: 'NC — normally closed (screw terminal)', connectsTo: "the external device's wire, if it should turn OFF when the relay activates", explanation: 'this path is closed until the relay energizes' },
    ],
    wiringNotes: 'The Arduino-side header (VCC/GND/IN) is low voltage and safe to touch; the screw-terminal side can carry mains voltage if wired that way — a beginner should only switch low-voltage DC loads until comfortable, and never touch the screw-terminal side while it\'s live.',
  },
  {
    id: 'seven-segment-display',
    name: '7-segment LED display (single digit, common cathode)',
    aliases: ['7-segment display', 'seven segment LED', 'single digit display', '7-seg', 'digit display'],
    category: 'display',
    identify: 'A small rectangular black plastic block (roughly the size of a postage stamp) with a figure-8-shaped arrangement of red (usually) glowing bars visible on the front, plus a small dot in the corner. It has a row of pins along the bottom edge, typically 10 in total (5 on each side).',
    whatItDoes: 'It shows a single digit (0-9) or a few letters by lighting up different combinations of its 7 bar-shaped segments (plus an optional decimal point dot).',
    howUsed: "Each segment is really its own tiny LED, so digitalWrite HIGH on a segment's pin (through a resistor) lights that bar — drawing a digit means turning on the right combination of segment pins. Since this is common-cathode, the shared common pin(s) go to GND and segments light when driven HIGH. Beginner gotcha: wiring 7-8 individual resistors is tedious, so many kits pair this with a 74HC595 shift register or a display driver library to cut down on wires.",
    legs: [
      { legName: 'segments a through g (7 pins)', connectsTo: 'a digital pin each, through its own ~220-330Ω resistor', explanation: 'each pin lights one bar of the digit independently' },
      { legName: 'decimal point (dp)', connectsTo: 'a digital pin through a resistor', explanation: 'lights the small corner dot, e.g. for showing a decimal value' },
      { legName: 'common pin(s), usually center or longest pins', connectsTo: 'Arduino GND (this is a common-cathode display)', explanation: 'shared ground return for every segment' },
    ],
    wiringNotes: 'Common-cathode and common-anode versions look identical from the outside but need opposite wiring logic (GND vs 5V on the common pin) — check the part number/datasheet before assuming; each segment still needs its own resistor.',
  },
  {
    id: 'lcd1602-i2c-backpack',
    name: '16x2 character LCD with I2C backpack (LCD1602 + PCF8574)',
    aliases: ['LCD1602', '16x2 LCD', 'I2C LCD', 'character LCD', '1602 display', 'HD44780 LCD'],
    category: 'display',
    identify: 'A rectangular blue (or sometimes green/white) screen roughly 8x3.5cm showing two rows of blocky text characters, with a small blue add-on circuit board soldered flat against the back. That backpack board has a small blue potentiometer (a tiny screw-adjustable dial) on it and only 4 pins sticking out, instead of the usual 16-pin row.',
    whatItDoes: 'It displays two lines of up to 16 text characters each, useful for showing sensor readings, menus, or status messages.',
    howUsed: 'Use the LiquidCrystal_I2C library: lcd.init(), lcd.backlight(), then lcd.setCursor(col, row) and lcd.print("text"). It only needs 4 wires because the I2C backpack handles all the character-driving logic. Beginner gotcha: the module\'s I2C address (commonly 0x27 or 0x3F) varies by manufacturer — if the screen shows nothing or garbled blocks, run an I2C scanner sketch first to find the right address, and check the contrast trim pot on the back.',
    legs: [
      { legName: 'GND', connectsTo: 'Arduino GND', explanation: 'common ground reference' },
      { legName: 'VCC', connectsTo: 'Arduino 5V', explanation: 'powers both the LCD panel and the I2C backpack' },
      { legName: 'SDA', connectsTo: "the Arduino's SDA/A4 pin", explanation: 'carries I2C data' },
      { legName: 'SCL', connectsTo: "the Arduino's SCL/A5 pin", explanation: 'carries the I2C clock signal' },
    ],
    wiringNotes: 'If the screen lights up but shows only solid blocks or nothing at all, turn the small blue contrast potentiometer on the backpack before assuming the wiring or code is wrong.',
  },
  {
    id: 'oled-ssd1306-096',
    name: 'OLED display module (SSD1306, I2C, 0.96")',
    aliases: ['SSD1306', '0.96 inch OLED', 'OLED screen', 'I2C OLED display', 'mini OLED'],
    category: 'display',
    identify: 'A tiny black square-ish PCB, about 2.7cm across, with a small rectangular black display window in the middle that looks blank/mirror-like when off. It has only 4 pins (GND, VCC, SCL, SDA) and no visible backlight or contrast knob.',
    whatItDoes: 'It\'s a small, crisp screen that lights up individual blue or white pixels directly (no backlight needed), used for text, icons, or simple graphics.',
    howUsed: 'Use the Adafruit_SSD1306 and Adafruit_GFX libraries: display.begin(), then draw text/shapes into a buffer with functions like display.print() or display.drawPixel(), and finally call display.display() to actually push the buffer to the screen. Beginner gotcha: forgetting the final display.display() call means nothing ever appears; the default I2C address is usually 0x3C but should be confirmed with an I2C scanner if the screen stays blank.',
    legs: [
      { legName: 'GND', connectsTo: 'Arduino GND', explanation: 'common ground reference' },
      { legName: 'VCC', connectsTo: 'Arduino 5V or 3.3V, depending on the specific board (check the silkscreen)', explanation: "powers the display's driver chip" },
      { legName: 'SCL', connectsTo: "the Arduino's SCL/A5 pin", explanation: 'carries the I2C clock signal' },
      { legName: 'SDA', connectsTo: "the Arduino's SDA/A4 pin", explanation: 'carries I2C data' },
    ],
    wiringNotes: 'Double-check whether your specific board wants 3.3V or 5V on VCC before powering it up — some have no onboard regulator and can be damaged by the wrong voltage.',
  },
  {
    id: 'ws2812b-neopixel-strip',
    name: 'WS2812B / NeoPixel addressable LED strip or ring',
    aliases: ['NeoPixel', 'WS2812B strip', 'addressable LED strip', 'RGB LED strip', 'pixel ring', 'smart LED strip'],
    category: 'output',
    identify: 'A flexible black or white strip (or a circular ring-shaped PCB) with small square LED chips spaced evenly along it, each chip slightly larger and flatter than a normal LED. Wires or pads at one end are usually labeled 5V/VCC, GND, and DIN (sometimes DOUT at the far end for chaining more strips/rings).',
    whatItDoes: "It's a strip of many LEDs where each individual LED's color and brightness can be set separately, all controlled through a single data wire.",
    howUsed: "Use the Adafruit_NeoPixel library: create a strip object with the pin and LED count, then strip.setPixelColor(index, r, g, b) for each LED and strip.show() to push the update out. Only one Arduino pin is needed for data no matter how many LEDs there are. Beginner gotcha: powering more than a few LEDs from the Arduino's 5V pin can overload and damage the board — use an external 5V supply with shared ground for anything beyond a handful of pixels, and add a small resistor (~300-500Ω) on the data line for reliability.",
    legs: [
      { legName: 'DIN (data in)', connectsTo: 'a digital pin on the Arduino, ideally through a ~300-500Ω resistor', explanation: "carries the precisely-timed data signal that sets each LED's color" },
      { legName: '5V / VCC', connectsTo: 'an external 5V power supply for more than a couple of LEDs', explanation: 'each LED can draw up to ~60mA at full brightness, which quickly exceeds what the Arduino can supply' },
      { legName: 'GND', connectsTo: "Arduino GND and the external supply's GND, tied together", explanation: 'grounds must be shared for the data signal to be read correctly' },
    ],
    wiringNotes: "Never run more than a few LEDs off the Arduino's own 5V pin; use a separate power supply and always connect its ground back to the Arduino.",
  },
  {
    id: '28byj48-stepper-uln2003',
    name: '28BYJ-48 stepper motor + ULN2003 driver board',
    aliases: ['28BYJ-48', 'ULN2003', 'stepper motor kit', 'stepper driver board', '5-wire stepper'],
    category: 'output',
    identify: "The motor is a small round blue metal-cased cylinder, noticeably heavier than it looks, with a thin 5-wire ribbon cable ending in a white 5-pin plug. The driver board is a small PCB with a black 16-pin chip printed 'ULN2003', four small LEDs, and a matching white 5-pin socket.",
    whatItDoes: "It's a motor that turns in small, precise fixed-size steps rather than spinning freely, useful for accurate positioning; the driver board supplies the extra current the Arduino's pins can't provide directly.",
    howUsed: "Use the built-in Stepper.h library (or AccelStepper for smoother control): define the steps-per-revolution and the four IN pins, then call step(count) to rotate. The four driver pins (IN1-IN4) connect to four Arduino digital pins, and the motor's own connector simply plugs into the driver board's matching socket. Beginner gotcha: if the motor buzzes or shakes instead of turning smoothly, the step sequence/library settings (not the wiring) are usually the cause, since the connector is keyed and can only plug in one way.",
    legs: [
      { legName: 'motor connector (5-pin, keyed)', connectsTo: "the ULN2003 driver board's matching socket", explanation: "the keyed plug means it can only be inserted correctly, so there's no wiring guesswork here" },
      { legName: 'IN1-IN4 (4 pins on driver board)', connectsTo: 'four digital pins on the Arduino', explanation: 'the library pulses these in sequence to step the motor' },
      { legName: '+ (power pin on driver board)', connectsTo: '5V, ideally from an external supply for smooth, reliable operation', explanation: "the motor can draw more current than is ideal to pull straight from the Arduino's regulator" },
      { legName: 'GND (driver board)', connectsTo: 'Arduino GND (and external supply GND if used)', explanation: 'common ground for the control signals' },
    ],
    wiringNotes: "The motor-to-driver connector is keyed so it can't be plugged in backwards; the four IN pins to the Arduino are the only wiring a beginner needs to get right, and library code handles the tricky step sequencing.",
  },
  {
    id: 'npn-transistor-switch',
    name: 'NPN transistor as a simple switch (e.g. 2N2222/S8050)',
    aliases: ['2N2222', 'S8050', 'NPN transistor', 'TO-92 transistor', 'small signal transistor'],
    category: 'passive',
    identify: "A tiny black plastic component shaped like a half-moon (flat on one side, rounded on the other) with three thin legs in a single row coming out the bottom. A part number like '2N2222' or 'S8050' is printed in tiny text on the flat face.",
    whatItDoes: "It acts like an electronically controlled valve: a small current/voltage on one leg lets a much larger current flow between the other two legs, letting a weak Arduino pin control something that needs more power than the pin can supply.",
    howUsed: "digitalWrite(pin, HIGH) into the base (through a resistor) turns the transistor on, allowing current to flow from collector to emitter and switch a load like a motor, buzzer, or LED strip section. Add a flyback diode across any motor or relay coil to protect the transistor. Beginner gotcha: pin order (Emitter/Base/Collector) is NOT universal across parts — always check the specific datasheet rather than assuming, and never connect the base directly to a pin without a resistor.",
    legs: [
      { legName: 'Emitter', connectsTo: "Arduino GND or the load's return path, depending on the exact circuit", explanation: 'provides the reference/return side of the switched current' },
      { legName: 'Base', connectsTo: 'a digital pin through a ~1kΩ resistor', explanation: 'a small current here turns the transistor on, enabling a larger collector-to-emitter current' },
      { legName: 'Collector', connectsTo: "the low side of the load being switched (load's other side goes to the supply voltage)", explanation: 'this is the higher-current path the transistor switches on and off' },
    ],
    wiringNotes: "Pin order (E-B-C) differs between part numbers and even between manufacturers of the 'same' part — always confirm with the datasheet; skipping the base resistor can destroy the transistor or overload the Arduino pin.",
  },
  {
    id: '74hc595-shift-register',
    name: '74HC595 shift register IC',
    aliases: ['74HC595', 'shift register', 'SIPO shift register', 'serial to parallel IC', 'SN74HC595'],
    category: 'communication',
    identify: "A small black rectangular chip (DIP package) with two rows of 8 pins each (16 total), a small semicircular notch or dot at one end marking pin 1, and '74HC595' printed on top in tiny text.",
    whatItDoes: 'It takes data sent one bit at a time over a few wires and turns it into 8 separate constant on/off outputs, letting the Arduino control many things (like 8 LEDs) using only 3 of its own pins.',
    howUsed: "Use the shiftOut(dataPin, clockPin, order, value) function to send a byte of data, then pulse the latch pin to make the new outputs appear all at once (multiple chips can be chained for even more outputs). Beginner gotcha: the OE (output enable) pin must be tied LOW and MR (master reset) tied HIGH, or the outputs will simply stay off no matter what data is sent — a very common 'it's not working' bug.",
    legs: [
      { legName: 'DS / SER (data in)', connectsTo: 'an Arduino digital pin, used as the data argument to shiftOut()', explanation: 'receives one bit of data at a time' },
      { legName: 'SHCP / SRCLK (shift clock)', connectsTo: 'an Arduino digital pin, used as the clock argument to shiftOut()', explanation: 'each pulse shifts one more bit into the register' },
      { legName: 'STCP / RCLK (latch)', connectsTo: 'an Arduino digital pin, pulsed after shiftOut()', explanation: 'copies the shifted-in bits to the output pins all at once' },
      { legName: 'OE (output enable)', connectsTo: 'Arduino GND', explanation: 'must be pulled LOW to enable the Q0-Q7 outputs' },
      { legName: 'MR (master reset)', connectsTo: 'Arduino 5V', explanation: 'must be held HIGH for normal operation; pulling it LOW clears the register' },
      { legName: 'Q0-Q7 (8 output pins)', connectsTo: "LEDs or other loads, each through its own resistor if driving LEDs", explanation: 'these become 8 new digital outputs controlled from just 3 Arduino pins' },
    ],
    wiringNotes: "If nothing lights up even though the code looks right, check OE and MR first — they're easy to forget and silently disable all outputs.",
  },
  {
    id: 'hc05-hc06-bluetooth-module',
    name: 'HC-05/HC-06 Bluetooth serial module',
    aliases: ['HC-05', 'HC-06', 'Bluetooth module', 'Bluetooth serial adapter', 'BT serial module'],
    category: 'communication',
    identify: 'A small blue PCB roughly 3.5x1.5cm with a shiny metal-can chip (the Bluetooth radio) mounted on it, a small onboard LED that blinks (fast when searching, slow/steady when connected), and a 4-6 pin header labeled with combinations of VCC, GND, TXD, RXD, and sometimes KEY/EN and STATE.',
    whatItDoes: 'It lets the Arduino send and receive data wirelessly over Bluetooth to a phone or computer, acting like a wireless replacement for the USB serial cable.',
    howUsed: "Communicate with it using Serial or SoftwareSerial at its configured baud rate (commonly 9600) — anything written with Serial.print() to that port gets sent over Bluetooth, and incoming Bluetooth data appears as if it were typed into that serial port. It pairs with a phone's Bluetooth serial terminal app like any other Bluetooth device. Beginner gotcha: the module's RXD pin is only 3.3V-tolerant on many boards, so feeding it the Arduino's 5V TX signal directly can degrade or damage it over time — a simple voltage divider is recommended.",
    legs: [
      { legName: 'VCC', connectsTo: "Arduino 5V (or 3.3V — check the specific board's silkscreen)", explanation: 'powers the Bluetooth module' },
      { legName: 'GND', connectsTo: 'Arduino GND', explanation: 'common ground reference' },
      { legName: 'TXD (module transmit)', connectsTo: 'the Arduino\'s RX pin (or a SoftwareSerial RX pin)', explanation: 'sends data from the module to the Arduino' },
      { legName: 'RXD (module receive)', connectsTo: "the Arduino's TX pin, ideally through a voltage divider", explanation: "receives data from the Arduino; many modules' RX input is only 3.3V-safe" },
      { legName: 'KEY/EN (optional)', connectsTo: '3.3V or a digital pin, only when entering AT command mode', explanation: 'some modules use this pin to switch into configuration mode' },
    ],
    wiringNotes: "Cross the wires (module TX to Arduino RX, module RX to Arduino TX) rather than connecting like-named pins together, and protect the module's RX pin with a simple resistor voltage divider from the Arduino's 5V TX line.",
  },
];
