export type BusErrorCode =
  | "bus_disabled"
  | "invalid_input"
  | "not_found"
  | "unauthorized"
  | "conflict"
  | "corrupt"
  | "lock_timeout"
  | "secret_detected"
  | "thread_parked"
  | "idempotency_conflict"
  | "io_error";

export class BusError extends Error {
  constructor(
    readonly code: BusErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BusError";
  }
}
