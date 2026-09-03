Bare, opens a "who answers" popup: your local endpoint, or OpenAI (only selectable once `/openai` has stored and verified a key). Choose OpenAI and a **second popup asks which model** — the tiers your key can actually reach, ranked for agentic work, each row carrying its price and its caveats. With an argument `/model` acts immediately, and the argument means one of three things depending on what you type.

`/model openai` or `/model local` switches which provider actually answers — that choice persists across restarts and every later `ayin` invocation. `/model openai <id>` switches *and* pins the model in one line, without a popup, which is the form to use over a connection that has no terminal to draw one on.

`/model qwen`, `/model gemma`, or `/model auto` do something else entirely: they force the tool-call dialect ayin speaks, overriding what it would otherwise infer from the model id the endpoint reports. That matters when the endpoint serves a model ayin doesn't recognize, or reports one incorrectly — it does not change which model actually runs; that is the endpoint's own configuration, which ayin cannot see or control.

## Choosing an OpenAI tier

The model list comes from your account, not from a table in ayin, so it can't offer an id that 404s and it picks up a new tier without an ayin release. What ayin adds is the guidance for the ids it recognises — and one of those notes reorders the list:

**On this endpoint, `gpt-5.5` is the only tier that takes function tools with reasoning left on.** The whole GPT-5.6 family (Sol, Terra, Luna) must run with `reasoning_effort: 'none'` for tools to work at all, which is every round of a coding loop. They are fast and cheap and they do no thinking before answering. Codex refuses `chat/completions` outright and cannot drive tools here.

So the practical shape is: a cheap tier for the ordinary loop, `gpt-5.5` for the task that actually needs reasoning — and the popup is one keystroke either way, which is the point.

This setting is **this agent only**. Subagents (`/set-subagent-model`), backgrounded runs (`/set-background-model`) and corpus builds (`/indulge-model`) are separate decisions and are not touched.

## Examples

    /model
    /model openai
    /model openai gpt-5.6-luna
    /model local
    /model qwen
