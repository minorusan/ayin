Bare, opens a "who answers" popup: your local endpoint, or OpenAI (only selectable once `/openai` has stored and verified a key). With an argument it acts immediately, and the argument means one of two different things depending on what you type.

`/model openai` or `/model local` switches which provider actually answers — that choice persists across restarts and every later `ayin` invocation. `/model qwen`, `/model gemma`, or `/model auto` do something else entirely: they force the tool-call dialect ayin speaks, overriding what it would otherwise infer from the model id the endpoint reports. That matters when the endpoint serves a model ayin doesn't recognize, or reports one incorrectly — it does not change which model actually runs; that is the endpoint's own configuration, which ayin cannot see or control.

## Examples

    /model
    /model openai
    /model local
    /model qwen
