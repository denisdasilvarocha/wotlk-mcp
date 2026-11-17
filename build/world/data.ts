import type { Hash } from 'node:crypto'

const decoder = new TextDecoder('utf-8', { fatal: true })
const sqlNull: unknown = JSON.parse('null')

export type Kind = 'integer' | 'unsigned' | 'real' | 'text' | 'blob'

export interface Column {
  readonly name: string
  readonly type: string
  readonly kind: Kind
}

export type Value = null | bigint | number | string | Uint8Array

function decodeInteger(text: string): bigint {
  if (!/^-?\d+$/u.test(text)) {
    throw new Error(`Invalid integer ${text}`)
  }

  const value = BigInt(text)

  if (value < -(1n << 63n) || value >= 1n << 63n) {
    throw new Error(`Integer out of SQLite range: ${text}`)
  }

  return value
}

function decodeUnsigned(text: string): string {
  if (!/^\d+$/u.test(text) || BigInt(text) >= 1n << 64n) {
    throw new Error(`Invalid unsigned integer ${text}`)
  }

  return BigInt(text).toString()
}

function decodeReal(text: string, column: Readonly<Column>, table: string): number {
  const value = Number(text)

  if (!text || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new Error(`World floating conversion loss in ${table}.${column.name}: ${text}`)
  }

  return value
}

export function decode(field: string, column: Readonly<Column>, table: string): Value {
  const { kind } = column

  if (field === 'N') {
    if (sqlNull !== null) {
      throw new Error('Invalid SQL null')
    }

    return sqlNull
  }

  if (!/^V(?:[0-9A-F]{2})*$/u.test(field)) {
    throw new Error('Invalid MySQL export field')
  }

  const bytes = Buffer.from(field.slice(1), 'hex')

  if (kind === 'blob') {
    return bytes
  }

  const text = decoder.decode(bytes)

  if (kind === 'integer') {
    return decodeInteger(text)
  }

  if (kind === 'unsigned') {
    return decodeUnsigned(text)
  }

  if (kind === 'real') {
    return decodeReal(text, column, table)
  }

  return text
}

export function hashRow(
  hash: Readonly<Pick<Hash, 'update'>>,
  columns: readonly Column[],
  values: readonly unknown[]
): asserts values is readonly Value[] {
  if (values.length !== columns.length) {
    throw new Error('Wrong number of exported fields')
  }

  for (let i = 0; i < columns.length; i++) {
    const { kind } = columns[i]
    const value = values[i]

    if (
      value !== null &&
      ((kind === 'integer' && typeof value !== 'bigint') ||
        (kind === 'real' && typeof value !== 'number') ||
        ((kind === 'unsigned' || kind === 'text') && typeof value !== 'string') ||
        (kind === 'blob' && !(value instanceof Uint8Array)))
    ) {
      throw new Error(`Invalid SQLite storage type for ${columns[i].name}`)
    }

    let bytes: Buffer
    let valueKind: string = kind

    if (value === null) {
      bytes = Buffer.alloc(0)
      valueKind = 'null'
    } else if (value instanceof Uint8Array) {
      bytes = Buffer.from(value)
    } else if (
      typeof value === 'bigint' ||
      typeof value === 'number' ||
      typeof value === 'string'
    ) {
      bytes = Buffer.from(String(value), 'utf8')
    } else {
      throw new Error(`Invalid SQLite storage type for ${columns[i].name}`)
    }

    hash.update(`${columns[i].type}:${valueKind}:${bytes.length}:`).update(bytes)
  }

  hash.update('\n')
}
