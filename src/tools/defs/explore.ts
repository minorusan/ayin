import type { Tool } from '../base.js';
import { exploreExecute } from '../explore/index.js';

export const tool: Tool = {
    name: 'explore',
    icon: '✲',
    description: 'START HERE when you do not already know the exact symbol or filename — use grep instead only when you know the literal string to match. One call runs a battery of read-only searches in parallel and returns ranked file:line spans quoted verbatim, plus the couplings that are NOT text: in Unity the .meta GUID binding a script to a prefab/.asset/.anim, in TypeScript the string keys (event names, tool names, prompt ids) joining files with no import between them. It derives the real identifiers from plain words, so "time bonus" finds GetTimeBonus(). Sub-second, deterministic, no model inside — it cannot invent anything, and "NOTHING FOUND" is a real answer. Cheap enough to call repeatedly: ask narrow questions and follow the pointers it returns.',
    parameters: [
      { name: 'question', type: 'string', description: 'What you are looking for, in plain words — "how is the score multiplier applied", "where is the time bonus calculated", "where is chat:send handled". You do not need the exact name; it derives identifiers (scoreMultiplier, GetTimeBonus) itself. Quote anything that must match literally. Asks WHERE/WHAT, not WHY — it locates code, it does not explain behaviour.', required: true },
      { name: 'context', type: 'string', description: 'Optional extra context — file paths, class names, error messages, stack frames', required: false },
    ],
    async execute(params) {
      return exploreExecute(params);
    },
  };
