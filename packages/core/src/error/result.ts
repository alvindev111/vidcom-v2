/** Successful result returned by a Core operation. */
export type Ok<Value> = { ok: true; value: Value };

/** Expected failure returned by a Core operation. */
export type Err<Failure> = { ok: false; error: Failure };

/** Explicit success/failure value used instead of throwing expected domain errors. */
export type Result<Value, Failure> = Ok<Value> | Err<Failure>;

/** Creates a successful Core result. */
export function ok<Value>(value: Value): Ok<Value> {
  return { ok: true, value };
}

/** Creates a failed Core result. */
export function err<Failure>(error: Failure): Err<Failure> {
  return { ok: false, error };
}
