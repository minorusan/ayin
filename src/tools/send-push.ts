/**
 * send_push tool — push a notification to the user's phone via the Maradel backend.
 *
 * Calls the backend's POST /api/push (same daemon that serves /api/generate + /api/docs/search),
 * which funnels through push/fcm.ts#sendPush → FCM. This is the OUT-OF-PROCESS counterpart to
 * Maradel's own in-process `send_push` tool: both reach the phone through the one FCM door.
 * Endpoint chosen via KELI_URL, identical to connection.ts. Graceful: if push isn't configured or
 * no device is registered, the backend returns { delivered: 0 } and this reports that plainly.
 */

import { log } from '../log.js';
import { addMessage } from '../ui.js';
import { keliBaseUrl } from '../connection.js';

export async function sendPushExecute(params: Record<string, string>): Promise<string> {
  const title = (params.title ?? '').trim();
  const body = (params.body ?? '').trim();
  if (!title) return 'Error: title required';
  if (!body) return 'Error: body required';

  addMessage('system', `Sending push: ${title}`);
  log('INFO', 'send_push_start', { title: title.substring(0, 80) });

  const base = keliBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/api/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return `Error: send_push could not reach the Maradel backend at ${base} (${e instanceof Error ? e.message : String(e)})`;
  }

  if (!res.ok) {
    const text = await res.text();
    return `Error: send_push ${res.status}: ${text.substring(0, 300)}`;
  }

  const data = (await res.json()) as { delivered?: number };
  const delivered = data.delivered ?? 0;
  log('INFO', 'send_push_done', { delivered: String(delivered) });
  return delivered > 0
    ? `Push sent to ${delivered} device(s).`
    : "Push not delivered — no device is registered or push isn't configured on the backend.";
}
