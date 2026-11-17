export type DbcBuffer = Readonly<
  Pick<
    Buffer,
    'length' | 'indexOf' | 'toString' | 'readFloatLE' | 'readUInt32LE' | 'readUIntLE' | 'readIntLE'
  >
>
type Field = Readonly<{ type: string; unsigned: boolean; size: number }>

function text(
  data: DbcBuffer,
  offset: number,
  strings: number,
  stringStart: number,
  name: string
): string {
  if (offset >= strings) {
    throw new Error(`Invalid string offset in ${name}`)
  }

  const end = data.indexOf(0, stringStart + offset)

  if (end < 0 || end >= data.length) {
    throw new Error(`Unterminated string in ${name}`)
  }

  return data.toString('utf8', stringStart + offset, end)
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
    return data.readFloatLE(cursor)
  }
  if (field.type.includes('string')) {
    return text(data, data.readUInt32LE(cursor), strings, stringStart, name)
  }
  if (field.unsigned) {
    return data.readUIntLE(cursor, field.size)
  }
  return data.readIntLE(cursor, field.size)
}
