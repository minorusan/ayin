/**
 * What a PROVIDER is given. The mirror of `tools/runtime.ts`, for the other extractable directory.
 *
 * WHICH PROVIDERS THIS IS FOR
 *
 * `direct` and `resource` speak ayin's own HTTP contract and use ayin's transport (`connection.ts`,
 * which ten core modules share). They are not third-party adapters; they ARE the contract, and they stay
 * in core. The vendor providers — `ollama`, `openai`, and whatever comes next — are the ones that belong
 * in a package of their own, and they were reaching into core for three things: the logger, config, and
 * the pending-image queue for vision turns.
 *
 * Same rules as the tool runtime: no imports in this file, unset is a throw, and services are resolved
 * on CALL so a provider module can be imported before core wires anything.
 */

export interface ProviderLogger {
  info(event: string, fields?: Record<string, string>): void;
  warn(event: string, fields?: Record<string, string>): void;
  error(event: string, fields?: Record<string, string>): void;
}

export interface ProviderServices {
  log: ProviderLogger;
  /** One config value by key. A provider reads config; it does not own where config lives. */
  config(key: string): string | undefined;
  /**
   * Images staged for the next vision turn, consumed exactly once. A provider that can attach them
   * takes them; one that cannot never calls this, and the queue stays for whoever can.
   */
  takePendingImages(): string[];
  /**
   * A stored credential for a vendor that needs one, by name (`openai`), and the setup text to show
   * when it is absent.
   *
   * Config would not do: a key is not a setting. It belongs in a 0600 file of its own, written by the
   * command that verifies it, and a provider must not have to know which file or how it got there —
   * exactly the reason `config` and `log` arrive this way. `setupHint` travels WITH the credential
   * because the provider is where the absence is discovered, and a fresh clone's first prompt is the
   * one error message that has to carry the whole instruction.
   */
  credential(vendor: string): { key: string; model: string; setupHint: string };
}

let services: ProviderServices | null = null;

export function initProviderRuntime(next: ProviderServices): void {
  services = next;
}

function require_(): ProviderServices {
  if (!services) {
    throw new Error(
      'provider runtime not initialized — a provider asked for config, the log or pending images ' +
        'before ayin wired them. Core must call initProviderRuntime() at boot.',
    );
  }
  return services;
}

export function providerLog(): ProviderLogger {
  return require_().log;
}

export function providerConfig(key: string): string | undefined {
  return require_().config(key);
}

export function providerPendingImages(): string[] {
  return require_().takePendingImages();
}

export function providerCredential(vendor: string): { key: string; model: string; setupHint: string } {
  return require_().credential(vendor);
}

export function providerRuntimeReady(): boolean {
  return services !== null;
}
