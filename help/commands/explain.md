Explains a feature or answers a question about this codebase as a narrative, backed by real git history and authorship — not just a file listing.

`/explain` runs an explore pass over the code, then pulls the actual commit history and authorship for what it found, cross-referencing any Jira tickets validated from commit messages, and synthesizes all of it into plain prose, opened in your editor. No diagram — that was tried and deliberately dropped, so the report reads like a colleague's story rather than a spec. It goes further than a plain code search: two people asking "how does auth work here" and "who touched the session cookie last, and why" both land in `/explain`, where a search tool would only answer the first. The same pipeline runs headless as `ayin explain "<question>"`, which prints the narrative and exits.

## Examples

    /explain the llm resource
    /explain how session cookies get invalidated
