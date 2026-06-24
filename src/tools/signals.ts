/**
 * Signal Extractor — scans gathered facts for structural code patterns.
 *
 * For every action found, checks if its counterpart exists in the evidence.
 * Pure pattern matching, no LLM. This catches contradictions that the model
 * would miss due to anchoring bias.
 *
 * Each rule is a simple function: (facts, task) => signal string or null.
 * Easy to add, remove, or modify rules.
 */

export interface Signal {
  /** Short label for the signal */
  label: string;
  /** The actual finding */
  finding: string;
}

type SignalRule = (allText: string, autoDiscovered: string, task: string) => Signal[];

// ── Rules ──────────────────────────────────────────────────────────

/** Rule 1: Error message keywords — extract the literal error and annotate key words */
const errorKeywords: SignalRule = (all) => {
  const signals: Signal[] = [];
  const patterns = [
    /error[:\s]*["']?([^"'\n]{10,120})/i,
    /exception[:\s]*["']?([^"'\n]{10,120})/i,
    /\[([A-Z]\w+)\]\s+(.{10,80})/,
  ];
  for (const pat of patterns) {
    const m = all.match(pat);
    if (m) {
      const msg = m[0].substring(0, 120);
      signals.push({ label: 'Error message', finding: `"${msg}"` });

      const lower = msg.toLowerCase();
      if (lower.includes('not found'))
        signals.push({ label: 'Error keyword', finding: '"not found" = item was NEVER present, not removed after being added' });
      if (lower.includes('already'))
        signals.push({ label: 'Error keyword', finding: '"already" = duplicate action or stale state' });
      if (lower.includes('timeout') || lower.includes('cannot connect'))
        signals.push({ label: 'Error keyword', finding: 'timeout/connection = infrastructure issue, not code logic' });
      if (lower.includes('null'))
        signals.push({ label: 'Error keyword', finding: 'null reference = a field or return value is null at access time' });
      if (lower.includes('canceled') || lower.includes('cancelled'))
        signals.push({ label: 'Error keyword', finding: 'cancellation = operation was intentionally stopped, may be normal flow' });
      break;
    }
  }
  return signals;
};

/** Rule 2: Action/counterpart pairs — for each Add, check Remove; for each Subscribe, check Unsubscribe */
const actionCounterparts: SignalRule = (all, autoDiscovered) => {
  const signals: Signal[] = [];
  const hasCallSites = autoDiscovered.length > 50;

  const pairs: Array<[string, string, string, string]> = [
    ['Add\\w+', 'Add/Register', 'Remove\\w+', 'Remove/Unregister'],
    ['Register\\w+', 'Register', 'Unregister\\w+', 'Unregister'],
    ['Subscribe|\\w+\\s*\\+=', 'Subscribe/+=', 'Unsubscribe|\\w+\\s*-=', 'Unsubscribe/-='],
  ];

  for (const [actionPat, actionName, counterPat, counterName] of pairs) {
    const actionRe = new RegExp(`\\b${actionPat}\\s*\\(`, 'g');
    const actions = all.match(actionRe);
    if (actions && actions.length > 0) {
      signals.push({ label: actionName, finding: `FOUND: ${[...new Set(actions)].slice(0, 3).join(', ')}` });

      const counterRe = new RegExp(`\\b${counterPat}\\s*\\(`, 'g');
      if (hasCallSites) {
        const inCalls = autoDiscovered.match(counterRe);
        if (inCalls && inCalls.length > 0) {
          signals.push({ label: counterName, finding: `CALLED in code: ${[...new Set(inCalls)].slice(0, 3).join(', ')}` });
        } else {
          signals.push({ label: counterName, finding: 'NOT CALLED in any discovered code flow (method definition may exist but is not invoked in this path)' });
        }
      } else {
        const inAll = all.match(counterRe);
        if (inAll && inAll.length > 0) {
          signals.push({ label: counterName, finding: `exists: ${[...new Set(inAll)].slice(0, 3).join(', ')}` });
        } else {
          signals.push({ label: counterName, finding: 'NOT FOUND anywhere in gathered code' });
        }
      }
    }
  }
  return signals;
};

/** Rule 3: CancellationToken lifecycle */
const ctsLifecycle: SignalRule = (all) => {
  const signals: Signal[] = [];
  if (/new\s+CancellationTokenSource/.test(all)) {
    signals.push({ label: 'CTS', finding: 'CancellationTokenSource created' });
    if (/\.Cancel\s*\(/.test(all)) signals.push({ label: 'CTS', finding: '.Cancel() called' });
    else signals.push({ label: 'CTS', finding: '.Cancel() NOT found' });
    if (/[Cc]ancellation\w*\s*=\s*null/.test(all)) signals.push({ label: 'CTS', finding: 'set to null explicitly' });
  }
  return signals;
};

/** Rule 4: Null assignments */
const nullAssignments: SignalRule = (all) => {
  const nulls = all.match(/\w+\s*=\s*null\s*;/g);
  if (nulls && nulls.length > 0) {
    return [{ label: 'Null assignments', finding: [...new Set(nulls)].slice(0, 5).join(', ') }];
  }
  return [];
};

/** Rule 5: Explore negations — when searches returned nothing */
const exploreNegations: SignalRule = (all) => {
  const negations = all.match(/(?:not found|no (?:matches|results|output)|does not (?:contain|exist|have))[^.]{0,60}/gi);
  if (negations && negations.length > 0) {
    return [{ label: 'Search negations', finding: [...new Set(negations)].slice(0, 3).join('; ') }];
  }
  return [];
};

// ── All rules ──────────────────────────────────────────────────────

const ALL_RULES: SignalRule[] = [
  errorKeywords,
  actionCounterparts,
  ctsLifecycle,
  nullAssignments,
  exploreNegations,
];

// ── Public API ─────────────────────────────────────────────────────

/**
 * Extract signals from gathered facts. Returns formatted string for the critic prompt,
 * or empty string if no signals found.
 */
export function extractSignals(facts: string[], task: string): string {
  const all = facts.join('\n') + '\n' + task;
  // Extract ONLY the auto-discovered sections (after the RELATED marker), not the code before it
  const autoDiscovered = facts
    .map(f => {
      const idx = f.indexOf('RELATED (auto-discovered');
      if (idx >= 0) return f.substring(idx);
      const idx2 = f.indexOf('auto-discovered');
      if (idx2 >= 0) return f.substring(idx2);
      return '';
    })
    .filter(f => f.length > 0)
    .join('\n');

  const signals: Signal[] = [];
  for (const rule of ALL_RULES) {
    signals.push(...rule(all, autoDiscovered, task));
  }

  if (signals.length === 0) return '';

  const formatted = signals
    .map(s => `- ${s.label}: ${s.finding}`)
    .join('\n');

  return `\n\nKEY SIGNALS (extracted programmatically — no speculation, just pattern matching):\n${formatted}\n`;
}
