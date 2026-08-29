import type { Tool } from '../base.js';
import { diagramExecute } from '../diagram.js';

export const tool: Tool = {
    name: 'diagram',
    icon: '⬡',
    description: 'Explain a CONCEPT or an architecture with a PICTURE: generate a validated PlantUML diagram, write it as a .puml next to the work, render it and open it. Use this whenever a structure, flow, lifecycle or relationship is easier seen than read — and whenever the user says they do not understand something, asks you to explain better, or asks for a diagram/schema/visual/mindmap. The diagram is checked by the real PlantUML renderer and repaired in a loop until it actually parses, so what you get back always renders. Pass `context` with real facts (file names, functions, events) you already gathered — without it the picture will be generic. `kind=mindmap` is the strongest choice for "explain this concept to me" — it radiates from one central idea instead of forcing an arbitrary sequence/class shape onto something that isn\'t really a process. NOT for Arduino wiring/circuits — use arduino_diagram for that; it is grounded in the real project and its own component catalog, which this generic tool has no access to.',
    parameters: [
      { name: 'subject', type: 'string', description: 'What the diagram must explain, in a phrase. e.g. "how a chat request flows from the CLI to the model and back", "the tiered-memory concept".', required: true },
      { name: 'kind', type: 'string', description: 'Optional diagram type to force: sequence | class | component | activity | state | mindmap. Omit to let it choose; prefer mindmap for "explain this concept".', required: false },
      { name: 'context', type: 'string', description: 'Optional grounding — real module/function/event names, or findings from explore/read_file, so the diagram names your actual code.', required: false },
      { name: 'render', type: 'string', description: 'Optional render mode override: svg | png | 0.', required: false },
    ],
    async execute(params) {
      return diagramExecute(params);
    },
  };
