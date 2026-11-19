import type { Field } from './layout.ts'

export type DbcBuffer = Readonly<
  Pick<
    Buffer,
    | 'length'
    | 'indexOf'
    | 'subarray'
    | 'toString'
    | 'readFloatLE'
    | 'readUInt32LE'
    | 'readUIntLE'
    | 'readIntLE'
  >
>

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function text(
  data: DbcBuffer,
  offset: number,
  strings: number,
  stringStart: number,
  name: string,
  field: string
): string {
  if (offset >= strings) {
    throw new Error(`Invalid string offset in ${name}`)
  }

  const end = data.indexOf(0, stringStart + offset)

  if (end < 0 || end >= data.length) {
    throw new Error(`Unterminated string in ${name}`)
  }

  try {
    return decoder.decode(data.subarray(stringStart + offset, end))
  } catch {
    throw new Error(`Invalid UTF-8 in dbc_${name}.${field} at string-block offset ${offset}`)
  }
}

export function readValue(
  data: DbcBuffer,
  field: Field,
  cursor: number,
  strings: number,
  stringStart: number,
  name: string
): number | string {
  if (field.type === 'float') {
    const value = data.readFloatLE(cursor)
    const negativeZero = Object.is(value, -0)
    if (Number.isNaN(value) || negativeZero) {
      throw new Error(
        `DBC floating conversion loss in dbc_${name}.${field.name}: ${negativeZero ? '-0' : value}`
      )
    }
    return value
  }
  if (field.type.includes('string')) {
    return text(data, data.readUInt32LE(cursor), strings, stringStart, name, field.name)
  }
  if (field.unsigned) {
    return data.readUIntLE(cursor, field.size)
  }
  return data.readIntLE(cursor, field.size)
}
