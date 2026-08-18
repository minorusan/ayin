The first prompt you type in a session is automatically looked up in the repo's corpus, with no `/embed` needed.

A first prompt states the task ("why is the login flow dropping the session cookie"), while later prompts in the same session are usually refinements of it — so only the first one is worth the corpus lookup by default. If `ayin indulge` has built a corpus for the repo and corpus injection is on (`/corpus`, default ON), the lookup runs before the agent's first round and any related answers are noted in the chat. Every prompt after the first needs `/embed` (for the rest of the session) or `/embedthis <question>` (for one more) to get the same treatment.

## Examples

    why does the reward service double-fire on retry?

The lookup happens on its own — there is nothing extra to type beyond the question itself.
