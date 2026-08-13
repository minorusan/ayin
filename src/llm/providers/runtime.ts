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

export function providerRuntimeReady(): boolean {
  return services !== null;
}
