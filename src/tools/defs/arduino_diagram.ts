import type { Tool } from '../base.js';
import { arduinoDiagramExecute } from '../arduino-diagram.js';

export const tool: Tool = {
    name: 'arduino_diagram',
    icon: '🔌',
    description: 'Draw the WIRING for the Arduino project in the current directory: one rectangle for the board (Uno or Nano) with a nested rectangle per pin actually used, one rectangle per real component with a nested rectangle per leg, wires drawn as labeled arrows between exact pins — grounded in the real sketch code and the arduino_db catalog, never a generic/invented circuit. Written as a validated .puml + rendered .svg (an editable vector — draggable in Inkscape/draw.io, not a flattened picture) and opened in VS Code. Use this whenever the user asks about wiring, a circuit, or "how does this connect" for an Arduino project — never use the generic diagram tool for wiring, it has no idea what components are actually wired.',
    parameters: [
      { name: 'board', type: 'string', description: 'Which board to label the diagram for: uno | nano. Defaults to uno. Only affects the board rectangle\'s title — pins shown are always just the ones the code actually touches, not a full physical pinout.', required: false },
    ],
    async execute(params) {
      return arduinoDiagramExecute(params);
    },
  };
