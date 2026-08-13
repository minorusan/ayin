/**
 * Theme — every color the TUI uses, in one place. Widgets never hardcode colors; they read `theme`.
 *
 * Themes are named presets of the SAME shape (`Theme`). Swap the whole look in one of two ways:
 *   - set `AYIN_THEME=indigo` (or any key in `themes`) in the environment, or
 *   - change `DEFAULT_THEME` below.
 * Add a new look by dropping another `Theme` object into `themes` — nothing else changes.
 *
 * Meaning-locked slots (do not repurpose across themes): `ok/warn/err` (the status semaphore) and the
 * diff add/del colors — these carry green=good / red=bad / red=removed semantics regardless of brand.
 */

export interface Theme {
  // brand accent (the agent's signature hue)
  accent: string; accentBright: string; accentDim: string;
  // text
  text: string; dim: string; faint: string; muted: string; subtle: string;
  // surfaces
  bg: string; panelBg: string; statusBg: string; statusFg: string; border: string;
  // agent states (must stay mutually distinguishable)
  thinking: string; tool: string; explaining: string; summarizing: string;
  // status-bar semaphore (meaning-locked)
  ok: string; warn: string; err: string;
  // diff cards (write_file); add/del meaning-locked
  diffFileFg: string; diffFileBg: string;
  diffHunkFg: string; diffHunkBg: string;
  diffAddFg: string; diffAddBg: string;
  diffDelFg: string; diffDelBg: string;
  diffCtx: string;
  // markdown rendering (the assistant's answers)
  mdH1: string; mdH2: string; mdH3: string;
  mdRule: string; mdCodeFrame: string; mdCode: string; mdInlineCode: string;
}

/** Rich green — deep emerald brand on a green-tinted near-black. The default. */
const green: Theme = {
  accent: '#35C08A',        // rich emerald — the ayin green
  accentBright: '#7BE9B4',  // pulse highlight (mint)
  accentDim: '#2C6E50',

  text: 'white',
  dim: '#59685f',
  faint: '#45524a',
  muted: '#6a7d71',
  subtle: '#9db0a3',

  bg: 'default',
  panelBg: '#0d1411',
  statusBg: '#111a15',
  statusFg: '#83968b',
  border: '#31473c',

  thinking: '#35C08A',      // emerald (matches accent) — ayin is thinking
  tool: '#E0AF68',          // amber — executing (contrasts the green)
  explaining: '#9ECE6A',    // lime — composing the answer
  summarizing: '#5CC8C2',   // teal — housekeeping

  ok: 'green', warn: 'yellow', err: 'red',

  diffFileFg: '#eafff3', diffFileBg: '#1f5c43',
  diffHunkFg: '#dcffe9', diffHunkBg: '#213029',
  diffAddFg: '#eafff1', diffAddBg: '#173d2d',
  diffDelFg: '#fff1f1', diffDelBg: '#4a1f24',
  diffCtx: '#9ab7a6',

  mdH1: '#7BE9B4', mdH2: '#35C08A', mdH3: '#5CC8C2',   // mint / emerald / teal headings
  mdRule: '#31473c', mdCodeFrame: '#45524a', mdCode: '#c3d4c9', mdInlineCode: '#E0AF68', // amber inline code
};

/** The original ayin indigo — kept as a swappable alternate (AYIN_THEME=indigo). */
const indigo: Theme = {
  accent: '#7B8CDE', accentBright: '#A8B6F5', accentDim: '#4a5490',

  text: 'white', dim: '#555', faint: '#444', muted: '#666', subtle: '#999',

  bg: 'default', panelBg: '#111', statusBg: '#1a1a1a', statusFg: '#888', border: '#444',

  thinking: '#7B8CDE', tool: '#E0AF68', explaining: '#9ECE6A', summarizing: '#BB9AF7',

  ok: 'green', warn: 'yellow', err: 'red',

  diffFileFg: '#f4f7ff', diffFileBg: '#365b8c',
  diffHunkFg: '#dbe7ff', diffHunkBg: '#2a3342',
  diffAddFg: '#eafff1', diffAddBg: '#173d2d',
  diffDelFg: '#fff1f1', diffDelBg: '#4a1f24',
  diffCtx: '#9aa7b7',

  mdH1: '#E5C07B', mdH2: '#E5C07B', mdH3: '#C678DD',   // the original One-Dark-ish markdown palette
  mdRule: '#444', mdCodeFrame: '#555', mdCode: '#ABB2BF', mdInlineCode: '#61AFEF',
};

export const themes = { green, indigo } satisfies Record<string, Theme>;
export type ThemeName = keyof typeof themes;

const DEFAULT_THEME: ThemeName = 'green';

/** The active theme. Env override (AYIN_THEME) → DEFAULT_THEME. Read once at import. */
export const theme: Theme = themes[(process.env.AYIN_THEME as ThemeName)] ?? themes[DEFAULT_THEME];
