import { ErrorCode, type DomainError } from "@vidcom/contracts";

/** Exact frame-rate ratio used as the timing authority for new mutations. */
export interface RationalFrameRate {
  numerator: number;
  denominator: number;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function decimalRate(fps: number): RationalFrameRate {
  const [coefficient, exponentText = "0"] = fps.toString().toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = `${whole}${fraction}`;
  const scale = fraction.length - exponent;
  const numerator = Number(digits) * (scale < 0 ? 10 ** -scale : 1);
  const denominator = scale > 0 ? 10 ** scale : 1;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

/**
 * Project frame grid represented as a rational rate rather than a rounded frame duration.
 *
 * Reads may contain legacy sub-frame values. Callers opt in only for values a mutation
 * is about to author; this object never normalizes or rewrites input silently.
 */
export class FrameGrid {
  readonly fps: number;

  private constructor(readonly rate: Readonly<RationalFrameRate>) {
    this.fps = rate.numerator / rate.denominator;
  }

  static fromFps(fps: number): FrameGrid {
    if (!Number.isFinite(fps) || fps <= 0) throw new RangeError("fps must be finite and greater than zero");
    return FrameGrid.fromRate(decimalRate(fps));
  }

  static fromRate(rate: RationalFrameRate): FrameGrid {
    if (!Number.isSafeInteger(rate.numerator) || rate.numerator <= 0
      || !Number.isSafeInteger(rate.denominator) || rate.denominator <= 0) {
      throw new RangeError("frame rate numerator and denominator must be positive safe integers");
    }
    const divisor = greatestCommonDivisor(rate.numerator, rate.denominator);
    return new FrameGrid({
      numerator: rate.numerator / divisor,
      denominator: rate.denominator / divisor,
    });
  }

  isAligned(seconds: number): boolean {
    if (!Number.isFinite(seconds)) return false;
    const frames = (seconds * this.rate.numerator) / this.rate.denominator;
    const tolerance = Math.max(1e-9, Number.EPSILON * Math.max(1, Math.abs(frames)) * 32);
    return Math.abs(frames - Math.round(frames)) <= tolerance;
  }

  validate(value: number, field: string): DomainError | null {
    return this.isAligned(value) ? null : {
      code: ErrorCode.TimingNotFrameAligned,
      message: `${field} must align to the project frame grid`,
      field,
      details: { value, fps: this.fps },
    };
  }
}
