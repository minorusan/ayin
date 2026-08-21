Everything ayin knows how to do with a Unity project from a shell, in one namespace: read an asset, change one property of it, and run tests for the assemblies you name. No Editor, no model — all of it is deterministic.

## unity prefab

    ayin unity prefab Assets/Prefabs/Widget.prefab
    ayin unity prefab Assets/Config/Settings.asset --depth 0
    ayin unity prefab Assets/Scenes/Main.unity --json --scalars

Prints the GameObject hierarchy, the components on each object under their **real** class (a `MonoBehaviour` whose script guid is `SkeletonGraphic.cs` shows as `SkeletonGraphic`), and every asset reference resolved from its guid to what it points at — `TMP_FontAsset named Montserrat-SemiBold SDF.asset at Assets/TextMesh Pro/FontRes/`. A reference with no asset behind it is called MISSING rather than skipped, because that is a real defect.

Nested prefab instances are followed into their source file and their overrides listed, three levels by default; `--depth 0` stays inside this one file. `--json` gives the full map (the same one `prefab_inspect` hands the agent, including every scalar property); `--scalars` keeps scalars in the readable tree. Accepts `.prefab`, `.unity` and `.asset` — one YAML dialect, three extensions.

## unity animator

    ayin unity animator Assets/Art/Animations/Cell.controller
    ayin unity animator Assets/Art/Animations/Cell.controller --json

States with their clips and clip lengths, and per transition the two things the file hides: whether it has an **exit time** (without one it fires the moment its conditions hold, cutting the clip mid-play) and whether the **clips overlap** — a duration is normalized to the source clip unless it is fixed, so `0.25` means a quarter of the clip you are leaving, and the arithmetic needs a length from another file. Conditions are spelled, not enumerated. Lines starting `!` are what only the assembled graph shows: a state nothing enters, a state nothing leaves, a transition with neither conditions nor exit time, a muted one, a cross-fade past the end of its clip.

## unity prefab_edit

    ayin unity prefab_edit Assets/Prefabs/Widget.prefab \
      --object Canvas/Progress/Slot0 --component SkeletonGraphic \
      --property m_SkeletonDataAsset --asset Hero_SkeletonData.asset

    ayin unity prefab_edit Assets/Prefabs/Widget.prefab \
      --object Root --component RectTransform --property m_Pivot.x --value 0.25

Sets ONE property, surgically — the file differs by one line, which is also the proof nothing else moved. `--asset` takes a file NAME and resolves it to a guid, keeping the existing fileID and type so the reference stays valid; `--value` writes a scalar as given, including one field of a vector (`m_Pivot.x`). Address the target exactly as `unity prefab` prints it, or `--component '#<fileID>'` when two components share a class.

It refuses rather than guesses: an ambiguous asset or object name, a property that is a map rather than a leaf, and a reference whose class does not match the field — `--asset GameConfig.asset` into `m_FontAsset` is a field Unity reads as null. The refusal names the way through. Properties only: it adds and removes nothing.

## unity test

    ayin unity test --assemblies
    ayin unity test Game.Tests,Game.Editor.Tests
    ayin unity test Game.Tests -v

`--assemblies` (also the bare `ayin unity test`) lists every test assembly in the project, whether it is **PlayMode or EditMode**, and whether its compiled DLL is current, stale or missing. Then name the ones you want, comma-separated.

Output is curt: `ok · 42 passed · 3 skipped · prebuilt DLLs` when everything passed, and nothing but the failed tests when something did not. `-v` prints the full report. Exit code is 1 on any failure or any assembly that did not run — an assembly that could not run is never folded into a pass.

Selection is by ASSEMBLY, which is what you want when you know the file you just touched. `ayin testrun "<domain>"` selects by corpus domain instead, for when you know the feature and not the assembly. Both execute through the same path: prebuilt DLLs from `Library/ScriptAssemblies` when they are current, Unity batch mode when they are not.

`/unity-test Asm1,Asm2` is the same thing inside a session, with the report in the chat.
