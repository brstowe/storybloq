/**
 * The values an MCP entry point captures ONCE and hands to the registrars
 * (T-502). Today that is the server's launch directory, which is the
 * directory Claude Code resolves project settings and `.mcp.json` from.
 *
 * Lives in its own module on purpose (ISS-1199): `mcp/index.ts` exports a
 * function whose signature names this type, so the module it comes from is
 * part of the emitted declaration graph. When it lived in `tools.ts`, the
 * dts build had to emit declarations for that whole file and its baseline
 * type errors (ISS-1040) turned fatal for every consumer packing from
 * source. A leaf module with no imports keeps the graph small.
 */
export interface RegistrationContext {
  readonly launchDir: string;
}
