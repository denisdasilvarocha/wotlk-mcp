/**
 * @param {unknown} value - Parsed value.
 * @returns {value is Readonly<Record<string, unknown>>} Whether value is a non-array object.
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value - Parsed value.
 * @returns {Readonly<Record<string, unknown>>} Object value.
 */
export function asRecord(value) {
  if (!isRecord(value)) {
    throw new TypeError('expected an object')
  }
  return value
}

/**
 * @param {unknown} value - Parsed value.
 * @returns {readonly unknown[]} Array value.
 */
export function asArray(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('expected an array')
  }
  return value
}

/**
 * @param {unknown} value - Parsed value.
 * @returns {string} String value.
 */
export function asString(value) {
  if (typeof value !== 'string') {
    throw new TypeError('expected a string')
  }
  return value
}
