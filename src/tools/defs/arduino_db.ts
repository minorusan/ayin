import type { Tool } from '../base.js';
import { arduinoDbExecute } from '../arduino-db.js';

export const tool: Tool = {
    name: 'arduino_db',
    description: 'Look up a common Arduino/electronics component in a reference catalog (~30 starter-kit parts: LEDs, buttons, servos, sensors, displays, drivers, ICs, …). Use this whenever you are writing or explaining Arduino code and need to know how to identify a part in a kit, what it does, or exactly which leg wires to which pin. NOT project-specific — it never knows what a particular sketch uses, only general reference facts about the part itself. Prefer this over recalling component facts from memory: it is curated and this codebase treats recalled hardware facts the same way it treats recalled API facts — a good way to wire something backwards.',
    parameters: [
      { name: 'query', type: 'string', description: 'Free-text search, e.g. "servo", "rgb led", "distance sensor", "how do I wire a button". Returns the top matches.', required: false },
      { name: 'id', type: 'string', description: 'Exact component id for a direct lookup (get ids from list=1 or a previous query hit), e.g. "sg90-micro-servo".', required: false },
      { name: 'list', type: 'string', description: 'Pass any truthy value (e.g. "1") to list every component id/name/category in the catalog instead of searching.', required: false },
    ],
    async execute(params) {
      return arduinoDbExecute(params);
    },
  };
