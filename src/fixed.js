// Arbitrary-precision fixed-point reals, built on BigInt.
//
// JavaScript gives us arbitrary-precision *integers* (BigInt) but no
// arbitrary-precision floats. So we represent a real number x as a BigInt
// mantissa m together with a precision p, where
//
//     x = m / 2^p
//
// Addition and subtraction are just BigInt + and -. Multiplication needs a
// shift back down by p. That's the whole idea.
//
// Everything here is exact except where noted; the rounding we do is
// round-to-nearest, which keeps error at half an ulp instead of a full one.

/** Multiply x by 2^e without overflowing on the way. */
export function ldexp(x, e) {
	if (x === 0 || !Number.isFinite(x)) return x;
	while (e > 1000) {
		x *= 2 ** 1000;
		e -= 1000;
		if (!Number.isFinite(x)) return x;
	}
	while (e < -1000) {
		x *= 2 ** -1000;
		e += 1000;
		if (x === 0) return x;
	}
	return x * 2 ** e;
}

const f64 = new DataView(new ArrayBuffer(8));

/**
 * Exact conversion from a double to fixed-point. We pull the IEEE-754 fields
 * apart by hand rather than multiplying by 2**p, which would overflow for
 * any interesting precision.
 */
export function fromNumber(x, prec) {
	if (x === 0 || !Number.isFinite(x)) return 0n;
	f64.setFloat64(0, x);
	const hi = f64.getUint32(0);
	const lo = f64.getUint32(4);
	const negative = (hi >>> 31) === 1;

	let exponent = (hi >>> 20) & 0x7ff;
	let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
	if (exponent === 0) exponent = 1; // subnormal
	else mantissa |= 1n << 52n; // restore the implicit leading bit

	// value = mantissa * 2^(exponent - 1075), so we want it shifted by prec more
	const shift = BigInt(prec) + BigInt(exponent) - 1075n;
	const m = shift >= 0n ? mantissa << shift : mantissa >> -shift;
	return negative ? -m : m;
}

/** Position of the highest set bit. */
export function bitLength(n) {
	if (n < 0n) n = -n;
	let bits = 0;
	while (n >= 0x100000000n) {
		n >>= 32n;
		bits += 32;
	}
	// Under 2^32, so Number() is exact and the tail loop is short.
	let x = Number(n);
	while (x >= 1) {
		x = Math.floor(x / 2);
		bits++;
	}
	return bits;
}

/**
 * Fixed-point back to double.
 *
 * The shift has to be measured from the top *set* bit, not from the binary
 * point. Trimming a fixed number of low bits would be fine for values near 1
 * and disastrous for values near 0 -- and orbits that pass close to zero are
 * precisely the ones perturbation leans on hardest. Keeping 64 significant
 * bits leaves the double conversion nothing to lose.
 */
export function toNumber(m, prec) {
	if (m === 0n) return 0;
	const negative = m < 0n;
	const magnitude = negative ? -m : m;

	const shift = bitLength(magnitude) - 64;
	const kept = shift > 0 ? magnitude >> BigInt(shift) : magnitude << BigInt(-shift);
	const value = ldexp(Number(kept), shift - prec);
	return negative ? -value : value;
}

/** (a * b) at precision prec, rounded to nearest. */
export function mul(a, b, prec) {
	const p = BigInt(prec);
	return (a * b + (1n << (p - 1n))) >> p;
}

/** Move a mantissa from one precision to another. */
export function rescale(m, from, to) {
	const d = to - from;
	if (d === 0) return m;
	return d > 0 ? m << BigInt(d) : m >> BigInt(-d);
}

/**
 * How many bits of precision we need for a view where one pixel spans
 * `perPixel` units. Guard bits absorb the error that accumulates over an
 * orbit; 48 is generous. Rounded up to a multiple of 64 because BigInt is
 * happiest on limb boundaries.
 */
export function precisionFor(perPixel, guardBits = 48) {
	const needed = Math.ceil(Math.log2(1 / Math.abs(perPixel))) + guardBits;
	return Math.max(64, Math.ceil(needed / 64) * 64);
}

/** Fixed-point to a decimal string with `digits` places after the point. */
export function toDecimalString(m, prec, digits) {
	const p = BigInt(prec);
	const negative = m < 0n;
	const v = negative ? -m : m;

	const scaled = (v * 10n ** BigInt(digits) + (1n << (p - 1n))) >> p;
	const s = scaled.toString().padStart(digits + 1, '0');
	const whole = s.slice(0, s.length - digits);
	const frac = s.slice(s.length - digits);

	return (negative ? '-' : '') + whole + (digits > 0 ? '.' + frac : '');
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** Parse a decimal string into fixed-point. Returns null if it isn't one. */
export function fromDecimalString(s, prec) {
	const match = DECIMAL.exec(String(s).trim());
	if (!match) return null;

	const [, sign, whole = '', frac = '', exp] = match;
	const digits = (whole || '') + (frac || '');
	if (digits === '') return null;

	const p = BigInt(prec);
	const value = BigInt(digits);
	const power = (exp ? parseInt(exp, 10) : 0) - (frac ? frac.length : 0);

	let m;
	if (power >= 0) {
		m = (value * 10n ** BigInt(power)) << p;
	} else {
		const divisor = 10n ** BigInt(-power);
		m = ((value << p) + divisor / 2n) / divisor;
	}
	return sign === '-' ? -m : m;
}
