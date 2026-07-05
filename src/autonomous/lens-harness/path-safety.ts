/**
 * Shared path traversal protection for the lens consumer harness (ISS-823
 * carry-over from the retired review-lenses fork).
 *
 * Used by context-packager.ts and secrets-gate.ts to validate that
 * changedFiles paths don't escape the project root via ../ traversal or
 * symlinks.
 */

import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Validates a file path stays within the project root.
 * Returns the real (symlink-resolved) absolute path, or null if unsafe.
 */
export function resolveAndValidate(
  projectRoot: string,
  file: string,
): string | null {
  const resolvedRoot = resolve(projectRoot) + sep;
  const fullPath = resolve(join(projectRoot, file));

  // Reject ../ traversal
  if (!fullPath.startsWith(resolvedRoot)) return null;

  // Reject symlinks pointing outside project root
  let realPath: string;
  try {
    realPath = realpathSync(fullPath);
  } catch {
    return null; // broken symlink or missing file
  }
  if (!realPath.startsWith(resolvedRoot)) return null;

  return realPath;
}
