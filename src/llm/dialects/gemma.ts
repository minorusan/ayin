/**
 * Gemma4 dialect — selected when the backend reports a `gemma*` model; also the
 * default dialect used until the active model id is known.
 *
 * Gemma4 reliably chains read → write → bash in a single response and often
 * "fuses" the parameter tag (<parameter=name</parameter>); the shared parser
 * handles that. The instructions below pin the canonical syntax to minimise it.
 * This block is byte-identical to the format ayin shipped before the manager
 * refactor, so behaviour is unchanged.
 */

import { XmlToolCallDialect } from './xml.js';

const TOOL_CALL_FORMAT = `Tool-call format — use EXACTLY this syntax, no variations:

<function=tool_name>
<parameter=param_name>
value
</parameter>
</function>

Example — running a shell command:

<function=bash>
<parameter=command>
ls -la /some/path
</parameter>
</function>

Critical: the parameter tag uses = not name=. Write <parameter=command> NOT <parameter name="command">.

Chaining: you may emit multiple tool calls in a single response and they will execute sequentially, each with its own result fed back. A common pattern is read_file then str_replace then bash (to verify). Do this in ONE response — do not split it across rounds. Do not repeat the same call twice in the same response.`;

export class GemmaDialect extends XmlToolCallDialect {
  readonly id = 'gemma';
  matches(modelId: string): boolean { return /gemma/i.test(modelId); }
  toolCallInstructions(): string { return TOOL_CALL_FORMAT; }
}
