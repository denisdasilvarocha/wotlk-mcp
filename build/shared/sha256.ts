import { createHash } from 'node:crypto'

// Lowercase hex SHA-256 of a UTF-8 string or bytes.
export function sha256Hex(data: string | Readonly<Pick<Uint8Array, 'subarray'>>): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? data : data.subarray())
    .digest('hex')
}
