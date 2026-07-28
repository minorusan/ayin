/**
 * Backend resource client — the one door to POST {keliBaseUrl}/resource/<name> {op, params},
 * plus the llm-authority acquisition dance shared by the watch daemon and `ayin rag`.
 * (The interactive TUI path gets the same behavior from the machine-local launcher wrapper.)
 */

import { keliBaseUrl } from './connection.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resourceOp(resource: string, op: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any | null> {
  try {
    const res = await fetch(`${keliBaseUrl()}/resource/${resource}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok ? body.data : null;
  } catch {
    return null;
  }
}

/** A granted hold. `token` is the authority token — required by every ACTION op on the llm
 *  resource (generate, setModel); read ops are open. */
export type LlmHold = { token: string; release: () => Promise<void> } | 'busy' | 'no-resource-layer';

/**
 * Take the backend llm resource as the `ayin` authority (ownership.gained → the backend swaps
 * gemma → the coder model; release/detach → reverts). 'busy' → someone else holds it — the
 * caller decides whether to defer (watch) or bail. 'no-resource-layer' → backend unreachable
 * or predates the resource layer: proceed best-effort on the served model.
 */
export async function acquireLlm(
  reason: string,
  opts: {
    ttlMs?: number;
    keepaliveMs?: number;
    force?: boolean;
    /**
     * Called when the keepalive comes back with a NEW grant instead of a refresh — which means the
     * old one is gone (the backend restarted and its in-memory authority stack went with it, or a
     * higher authority preempted us). Two things are then broken silently: our token is dead, so
     * anything sent with it is ignored; and the backend re-applied its per-holder MODEL policy, so a
     * pinned model has been swapped away. The holder gets the new token and a chance to re-pin.
     */
    onRegrant?: (token: string, via: string) => void;
  } = {},
): Promise<LlmHold> {
  const grant = await resourceOp('llm', 'authority.enqueue', {
    holder: 'ayin',
    reason,
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.force ? { force: true } : {}),
  }, 5_000);
  if (grant && grant.granted) {
    // Slide the grant for long runs, like the launcher does. A SHORT ttl with a fast keepalive is
    // what makes `/lock` self-releasing: stop responding and the grant lapses on its own.
    const every = opts.keepaliveMs ?? 10 * 60 * 1000;
    const keepalive = setInterval(() => {
      void resourceOp('llm', 'authority.enqueue', {
        holder: 'ayin',
        ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
      }, 5_000).then((r) => {
        if (!r?.granted || !r.token) return;
        // `refresh` = we still held it. Anything else is a NEW grant: rotate the token (the old one
        // is dead) and let the holder re-assert whatever the grant used to guarantee.
        if (r.via !== 'refresh' || r.token !== hold.token) {
          hold.token = String(r.token);
          opts.onRegrant?.(hold.token, String(r.via ?? 'unknown'));
        }
      });
    }, every);
    keepalive.unref();
    let released = false;
    const hold = {
      token: String(grant.token),
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(keepalive);
        const r = await resourceOp('llm', 'authority.detach', { token: hold.token }, 5_000);
        if (r?.released) return;
        // Our token was replaced (a restart, or a preempt) and the keepalive hadn't noticed yet, so
        // that detach freed nothing and the grant would sit there until its TTL. We ARE the `ayin`
        // holder, so re-acquire to learn the live token and hand it back properly. Bounded: only when
        // `ayin` still holds it, and only once.
        const who = await resourceOp('llm', 'authority.current', {}, 5_000);
        if (who?.holder !== 'ayin') return; // someone else owns it now — not ours to release
        const fresh = await resourceOp('llm', 'authority.enqueue', { holder: 'ayin' }, 5_000);
        if (fresh?.granted && fresh.token) await resourceOp('llm', 'authority.detach', { token: fresh.token }, 5_000);
      },
    };
    return hold;
  }
  if (grant && grant.busy) return 'busy';
  return 'no-resource-layer';
}
