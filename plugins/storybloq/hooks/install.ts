/**
 * Where the storybloq binary is. The repository copy answers the bare name,
 * which the host resolves on its PATH; the copy `storybloq setup-skill`
 * writes under ~/.claude/skills/storybloq/ answers the absolute path of the
 * global binary at install time, re-resolved by the version-marker refresh
 * when that binary moves (an nvm switch), so a Mod loaded by a client that
 * did not inherit the shell's PATH still finds it (T-507, commit D).
 */
export function resolveStorybloqBin(): string {
  return "storybloq";
}
