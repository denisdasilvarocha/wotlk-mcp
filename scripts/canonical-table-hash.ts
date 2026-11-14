import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export function canonicalTableHash(db: DatabaseSync, name: string): { hash: string; count: string } {
  const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`
  const columns = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all().filter((column) => Number(column.hidden) === 0).map((column) => String(column.name))
  const order = columns.map((column) => `typeof(${quote(column)}) COLLATE BINARY, ${quote(column)} COLLATE BINARY`).join(', ')
  const statement = db.prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(name)} ORDER BY ${order}`)
  statement.setReadBigInts(true)
  statement.setReturnArrays(true)
  const hash = createHash('sha256')
  const field = (type: string, bytes: Uint8Array): void => {
    hash.update(`${type}${bytes.byteLength}:`)
    hash.update(bytes)
  }
  field('v', Buffer.from('wotlk-table-v1'))
  for (const column of columns) field('c', Buffer.from(column))
  let count = 0n
  for (const row of statement.iterate() as Iterable<unknown[]>) {
    hash.update('r')
    for (const value of row) {
      if (value === null) field('n', Buffer.alloc(0))
      else if (typeof value === 'bigint') field('i', Buffer.from(value.toString()))
      else if (typeof value === 'number') {
        const bytes = Buffer.allocUnsafe(8)
        bytes.writeDoubleBE(value)
        field('f', bytes)
      } else if (typeof value === 'string') field('t', Buffer.from(value))
      else if (value instanceof Uint8Array) field('b', value)
      else throw new Error(`Unsupported SQLite value in ${name}`)
    }
    count++
  }
  return { hash: hash.digest('hex'), count: count.toString() }
}
