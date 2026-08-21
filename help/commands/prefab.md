Reads a Unity `.prefab`, `.unity` scene or `.asset` and shows what it actually describes: the GameObject hierarchy, the components on each object, and every asset reference resolved from its guid to the thing it points at.

A prefab names nothing it depends on. Every edge in it is a 32-hex guid whose only definition is a `.meta` file elsewhere in the project, so reading the file gives you numbers where the wiring should be — and the wiring is the half a bug usually lives in. This resolves them: `m_FontAsset: TMP_FontAsset named Montserrat-SemiBold SDF.asset at Assets/TextMesh Pro/FontRes/Fonts & Materials/`.

Components appear under their real class, not their serialized one — a `MonoBehaviour` whose script guid is `SkeletonGraphic.cs` is shown as `SkeletonGraphic`. Nested prefab instances are followed into their source file (three levels by default) and their overrides listed, so one tree covers what Unity shows across several files. A reference with no asset behind it is called MISSING rather than skipped, because that is a real defect worth seeing.

The tree opens in a scrollable overlay — Esc closes it, PgUp/PgDn scroll. The agent has the same reader as `prefab_inspect`, which returns the whole map as JSON, and `prefab_edit` changes one property of it.

## Examples

    /prefab Assets/Prefabs/Widget.prefab
    /prefab /full/path/to/Widget.prefab
