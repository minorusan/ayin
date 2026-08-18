Generates a wiring diagram for an Arduino sketch — a board rectangle, one rectangle per pin the code actually touches, one per real component from the parts catalog (with series resistors drawn as real nodes in the wire), connected by labeled arrows.

It only runs in an Arduino project — it probes for `.ino`/`.pde` files or `platformio.ini`/`sketch.yaml` and does nothing otherwise. The wiring itself is deterministic (matched from what the code touches against the parts catalog, not guessed by the model); the one LLM call in the pipeline just grounds ambiguous wiring choices. Output is PlantUML rendered to SVG, so the diagram opens as an editable vector — every box stays its own draggable group in Inkscape or draw.io — and opens in VS Code if it's on PATH.

## Examples

    /arduino-explain
