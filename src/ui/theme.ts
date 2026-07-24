/**
 * Theme — every color and glyph the TUI uses, in one place.
 * Change the look here; widgets never hardcode colors.
 */

export const theme = {
  // brand
  accent: '#7B8CDE',        // the ayin indigo
  accentBright: '#A8B6F5',  // pulse highlight
  accentDim: '#4a5490',

  // text
  text: 'white',
  dim: '#555',
  faint: '#444',
  muted: '#666',
  subtle: '#999',

  // surfaces
  bg: 'default',
  panelBg: '#111',
  statusBg: '#1a1a1a',
  statusFg: '#888',
  border: '#444',

  // agent states
  thinking: '#7B8CDE',
  tool: '#E0AF68',          // amber — something is executing
  explaining: '#9ECE6A',    // green — composing the answer
  summarizing: '#BB9AF7',   // violet — housekeeping

  // status bar semaphore
  ok: 'green',
  warn: 'yellow',
  err: 'red',

  // diff colors (write_file cards)
  diffFileFg: '#f4f7ff', diffFileBg: '#365b8c',
  diffHunkFg: '#dbe7ff', diffHunkBg: '#2a3342',
  diffAddFg: '#eafff1', diffAddBg: '#173d2d',
  diffDelFg: '#fff1f1', diffDelBg: '#4a1f24',
  diffCtx: '#9aa7b7',
} as const;
