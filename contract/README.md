# @ayin/contract

The interfaces between ayin and the two things it can be extended with: **tools** and **model
providers**. Types only. No runtime code, no dependencies, nothing to configure.

It exists so a tool package or a provider package can live in **its own repository — public or
private — and depend on an interface rather than on ayin's filesystem layout**. A private tool that
knows about one company's codebase, or a provider for an endpoint nobody else has, is then just a
package on that machine: never a fork to keep merging, never a name in a public artifact.

## The rules for this package

1. **Types and abstract shapes only.** If something here needs to *do* work — spawn a shell, read a
   file, call a model — it belongs on the other side of the seam and arrives by injection.
2. **Zero dependencies, forever.** Everything depends on this; it depends on nothing.
3. **A change here is a breaking change** to every tool and provider anyone has written. Add
   optional members; do not repurpose existing ones.

## What is in it

| Module | Contract |
|---|---|
| `tools` | `Tool`, `ToolParameter`, `BaseTool` — a name, a description, typed parameters, `execute()` |
| `prompts` | `PromptBundle` — how a tool reads its own prompt texts without knowing where they live |
| `llm` | `LlmProvider` and its result types — `generate()` and `status()` required, everything else an optional capability |
| `host` | `HostServices` — what a tool is GIVEN: a way to report progress, a model, a shell, a logger |

## The capability rule (providers)

`generate()` and `status()` are required; a provider without them is not a provider. Everything else
— a model catalog, model switching, an authority over a shared GPU, telemetry, an event stream — is
optional, and **an absent capability must render as nothing**. Not an error, not a spinner that never
resolves: the feature is simply not part of that installation.

## The injection rule (tools)

A tool never imports the agent. It receives what it needs: its prompts via `bindPrompts()`, and the
host's services via `bindHost()`. A tool that reaches into the agent's internals cannot be moved to
another repository, which is the whole point of this package.
