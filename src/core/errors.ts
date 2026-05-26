import type { ErrorCode } from "../models/types.js";

/** Schema version this loader understands. Config.schemaVersion > this → version_mismatch. */
export const CURRENT_SCHEMA_VERSION = 2;

export class ProjectLoaderError extends Error {
  readonly name = "ProjectLoaderError";

  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

export type LoadWarningType =
  | "parse_error"
  | "schema_error"
  | "duplicate_id"
  | "naming_convention"
  | "filename_id_mismatch";

/** Integrity warnings fail strict mode. Cosmetic warnings are collected but never block. */
export const INTEGRITY_WARNING_TYPES: readonly LoadWarningType[] = [
  "parse_error",
  "schema_error",
  "duplicate_id",
];

export interface LoadWarning {
  readonly file: string;
  readonly message: string;
  readonly type: LoadWarningType;
}
