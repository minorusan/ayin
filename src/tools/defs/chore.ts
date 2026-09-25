import type { Tool } from '../base.js';
import { chore } from '../../chore/cli.js';
import { DEFAULT_COMMITS } from '../../chore/index.js';

/**
 * WITHDRAWN — this tool is deliberately NOT registered. See `disabledTool` below.
 *
 * `loadTools` registers whatever a def exports as `tool` (or `tools`); exporting it under another
 * name is how a tool is taken out of circulation without deleting the work. Restoring it is renaming
 * this one identifier back.
 *
 * WHY. It answers "which members added recently does nothing reference" — and the honest name for
 * that answer is a WEAK SIGNAL, which the tool itself admits: every item it returns carries caveats
 * like `public — may be used outside this repository` and `in a test or editor path`. On the Unity
 * project it was run against, both of its two hits were public methods in an Editor assembly, exactly
 * the case where "no reference in this tree" says nothing about whether anything calls them. A model
 * reading that list reported the signal as weak on its own initiative.
 *
 * The tool never deletes anything, and that is not the point. Its OUTPUT is a list of things to
 * delete, produced on evidence that cannot support the deletion, handed to an agent that can delete.
 * Read-only is a property of the tool; destructive is a property of the loop it sits in.
 *
 * The `ayin chore` CLI is untouched. An operator running it on purpose reads the caveats, decides,
 * and is not going to remove a MenuItem because a grep missed it.
 */
export const disabledTool: Tool = {
    name: 'chore',
    icon: '🧹',
    description:
      'Find members added in recent commits that NOTHING uses — dead code while it is still fresh. Takes the '
      + 'files the last N commits touched (10 by default), extracts the methods, properties and fields those '
      + 'commits ADDED, drops any whose declaration is no longer in HEAD (added-then-removed is history, not '
      + 'dead code), and searches the whole tracked tree for each survivor. Every item carries the commit that '
      + 'introduced it, so it is a decision rather than an archaeology assignment. Code AND assets are searched: '
      + 'a Unity field is named from a prefab and a method can be named from an animation clip. Members invoked '
      + 'by reflection ([Test], [MenuItem], [SerializeField], DI) are excluded by default and counted, because '
      + 'they have no callers by design. Read-only.',
    parameters: [
      { name: 'commits', type: 'string', description: `How many commits back to look. Default ${DEFAULT_COMMITS}.`, required: false },
      { name: 'all', type: 'string', description: 'true also reports members that ARE used, and the reflection-invoked ones.', required: false },
      { name: 'html', type: 'string', description: 'true also writes the report as a page and opens it. For an operator, not for reading here.', required: false },
    ],
    slash: {
      command: 'chore',
      param: 'commits',
      usage: '/chore [commits] — members added recently that nothing uses; also opens the report as a page',
      // The operator gets the page as well as the text; the agent calling this tool gets text only, because
      // a browser tab is not an answer it can read.
      defaults: { html: 'true' },
    },
    async execute(params) {
      const commits = params.commits ? Number(params.commits) : undefined;
      const run = chore({
        repo: process.cwd(),
        commits: Number.isFinite(commits) ? commits : undefined,
        all: params.all === 'true',
        html: params.html === 'true',
      });
      return run.page
        ? `${run.text}\n\npage: ${run.page}${run.opened ? ' (opened in your browser)' : ''}`
        : run.text;
    },
  };
