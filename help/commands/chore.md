Finds the methods, properties and fields you added in the last few commits that nothing in the tree uses — and names the commit each one arrived in.

A dead-code scan over a whole repository returns hundreds of items, most of them public API, test helpers or serialized fields, and nobody reads that list twice. This asks the narrower question that has an owner: *of the members added in the last ten commits, which are used by nothing?* That set is small, it is fresh enough that whoever wrote it still remembers why, and every item comes with its introducing commit — so it is a decision rather than an archaeology assignment.

Three steps, all deterministic. The last N commits give the files they touched; the added lines in those files give the members they declared; and every candidate is then **re-checked against HEAD** — a member added in one commit and deleted in a later one is history, not dead code, and is dropped. What survives is searched across the branch as it stands now.

**Code and assets are both searched**, because a Unity `[SerializeField]` is written by the Editor and named from a prefab, and a method can be called from an animation clip — neither is visible to a search of C# alone. Members invoked by reflection (`[Test]`, `[MenuItem]`, `[RuntimeInitializeOnLoadMethod]`, DI targets) are excluded and counted rather than listed, since they have no callers by design. Everything else carries the reason it might still be alive: `override`, `virtual`, `public`, `partial`, a test path.

`/chore` prints the report in the chat **and** opens it as a page — grouped by confidence, most confident first. `/chore 25` looks back 25 commits. `ayin chore` is the same report as text from a shell; `ayin chore --all` includes the used and the reflection-invoked, for auditing the scan itself.

Declarations are recognised in `.cs`, `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs`.

## Examples

    /chore
    /chore 30
