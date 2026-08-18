Stores your OpenAI API key, verified against OpenAI before saving. It does not switch ayin to OpenAI — storing a credential and choosing which provider answers are two separate decisions.

A regex finds the `sk-…` key anywhere in whatever you paste, along with an optional model name in the same text; both go through one cheap, free verification call before anything is written to disk (`~/.ayin-cli/openai.env`, mode 0600). Bare `/openai` reports whether a key is already configured. Once a key is stored, `/model openai` is the actual switch that starts billing you per token — this command only makes that switch possible.

## Examples

    /openai sk-abc123...
    /openai sk-abc123... gpt-4.1
    /openai
