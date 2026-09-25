import type { Tool } from '../base.js';
import { diagramExecute } from '../diagram.js';

/**
 * WITHDRAWN. Exported as `disabledTool`, which the loader does not register — see `chore` and
 * `find_relevant_files` for the same treatment and the reason for it: the work and its reasons stay
 * on disk, and restoring it is renaming one identifier.
 *
 * A MODEL WROTE THE GRAPH, and the only check on it was that the PlantUML PARSED. That is a fact
 * about the syntax and never about the code, so the same subject twice gave two different pictures
 * and neither was evidence. Measured in one session on a real Unity project: it drew a toast flow
 * calling `ShowToast`, `SetData` and `StartAnimation`, none of which exist — `Toaster` declares
 * `CreateToast` and `GetToasterPrefab`. The session's own report had to be the thing that said so:
 * *"validated by plantuml (it parses) but that is not the same as validated against the code."*
 *
 * `map_dependencies` answers the structural half derived rather than drawn — types, members and
 * assemblies read out of the source, the same answer every time, no model in it anywhere. What goes
 * with this tool is the half nothing can derive: a sequence, an activity, a mindmap of an idea. That
 * is a real loss and it is the right trade, because an invented picture is worse than no picture —
 * it is read as evidence, and nothing downstream can tell.
 *
 * AND IT WAS THE LAST PLACE AYIN AUTHORED PLANTUML. `weave` still RENDERS a `.puml`, because that is
 * a document the operator may already have written; nothing generates one any more.
 */
export const disabledTool: Tool = {
    name: 'diagram',
    icon: '📐',
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
