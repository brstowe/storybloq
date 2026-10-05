/**
 * Fork feature: a board's AUTO AGENT switch.
 *
 * A per-board boolean saying whether this board is meant to be driven by the
 * autonomous agent. Default FALSE when absent, so no existing board becomes
 * auto-runnable by having this feature land.
 *
 * Deliberately a FLAG ONLY, per the owner's call, exactly as the shortcode is
 * an identifier only: nothing in the CLI reads it. `/story auto` and the
 * autonomous guide behave identically whether it is set or not. It records an
 * intent for other tools -- the dashboard decides whether to OFFER a run -- and
 * it is not a safety interlock. Do not start treating it as one without saying
 * so out loud: a flag that silently became a gate would make every board in
 * existence stop being auto-runnable, since the default is false.
 *
 * Each board owns its own. A federation node does NOT inherit the orchestrator
 * root's value: reads stay local, so flipping a root cannot quietly change what
 * four nodes are willing to do.
 */

/** Whether the value came from config, or is the absent-key default. */
export type AutoAgentSource = "config" | "default";

export interface ResolvedAutoAgent {
  readonly enabled: boolean;
  readonly source: AutoAgentSource;
}

/** The default for a board that has never set one. */
export const AUTO_AGENT_DEFAULT = false;

/**
 * FAILS CLOSED. Anything that is not a real boolean -- a string "true", a
 * number, null, an object -- resolves to the default rather than being coerced.
 *
 * Truthiness is the wrong tool here. `"false"` is a truthy string, so a
 * `Boolean(value)` reading of a hand-edited `"autoAgent": "false"` would turn
 * the owner's "off" into "on", which is the one direction this switch must
 * never fail in. `validate` reports the ignored value instead.
 */
export function resolveAutoAgent(config: { readonly autoAgent?: unknown }): ResolvedAutoAgent {
  const raw = config.autoAgent;
  if (typeof raw === "boolean") return { enabled: raw, source: "config" };
  return { enabled: AUTO_AGENT_DEFAULT, source: "default" };
}

/**
 * Parses the CLI's `<value>` positional. Returns `null` when the text is not a
 * recognised boolean, so the caller refuses rather than guessing.
 *
 * Accepts the spellings a person or a shell script actually types. `1`/`0` are
 * in because a dashboard or a script passes them; `yes`/`no` because people do.
 */
export function parseAutoAgentValue(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(v)) return true;
  if (["false", "0", "no", "off", "disable", "disabled"].includes(v)) return false;
  return null;
}
