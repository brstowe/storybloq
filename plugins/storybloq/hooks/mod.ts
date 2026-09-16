/**
 * The storybloq plugin's one hooks module (Claude Code function hooks).
 *
 * hooks/hooks.json names exactly this file: the client admits one module per
 * plugin, so every storybloq Mod registers through here. Each Mod lives in
 * its own file and is gated by its own `userConfig` option:
 *
 *   - sidebar.ts  T-508, the ledger dashboard (option `sidebar`, on by default)
 *
 * The client loads this module only under CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
 * and after workspace trust; a Mod whose option is off registers nothing, so
 * it costs no hook on any event. Event names are string literals at every
 * on() call, as the client's source scan requires; the pinned list they are
 * checked against is client-api.ts.
 *
 * The sidebar landed at 72f98679 (T-508). The roster Mod (T-507) was removed
 * by owner ruling on 2026-09-15: one dashboard Mod; the roster core stays.
 */

import { registerSidebar } from "./sidebar.js";

export type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>;
type Hook = ($: any, e: any, next: (e: any) => unknown) => unknown;
export type On = (event: string, hook: Hook) => unknown;

/**
 * `register(on, options)`: the entry the client calls once per activation.
 *
 * T-516: the dashboard is on unless the user turned it off, so the test is
 * "not false" rather than "is true". 2.1.273 does hand userConfig defaults
 * through (measured: a probe module saw its declared defaults with nothing
 * configured), which alone would be enough; reading an absent option as on
 * keeps a client that does not pass defaults from silently hiding the Mod.
 */
export function register(on: On, options: Options): void {
  const sidebar = options["sidebar"] !== false;
  if (sidebar) registerSidebar(on, options);
}
