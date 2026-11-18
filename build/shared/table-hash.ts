import { createHash } from 'node:crypto'

import type { Database } from '../../src/database.ts'
import type { Hash } from 'node:crypto'

function hashField(
  hash: Readonly<Pick<Hash, 'update'>>,
  type: string,
  bytes: Readonly<Pick<Uint8Array, 'byteLength' | 'subarray'>>
): void {
  hash.update(`${type}${bytes.byteLength}:`)
  hash.update(bytes.subarray())
}

function hashValue(hash: Readonly<Pick<Hash, 'update'>>, value: unknown, name: string): void {
  if (value === null) {
    hashField(hash, 'n', Buffer.alloc(0))
  } else if (typeof value === 'bigint') {
    hashField(hash, 'i', Buffer.from(value.toString()))
  } else if (typeof value === 'number') {
    const bytes = Buffer.allocUnsafe(8)
    bytes.writeDoubleBE(value)
    hashField(hash, 'f', bytes)
  } else if (typeof value === 'string') {
    hashField(hash, 't', Buffer.from(value))
  } else if (value instanceof Uint8Array) {
    hashField(hash, 'b', value)
  } else {
    throw new Error(`Unsupported SQLite value in ${name}`)
  }
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function canonicalTables(db: Database): string[] {
  return db
    .prepare(
      "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'meta' ORDER BY name COLLATE BINARY"
    )
    .all()
    .map((row: Readonly<Record<string, unknown>>) => String(row.name))
}

function hashRows(
  hash: Readonly<Pick<Hash, 'update'>>,
  statement: ReturnType<Database['prepare']>,
  name: string,
  ...parameters: readonly string[]
): bigint {
  statement.setReadBigInts(true)
  statement.setReturnArrays(true)

  let count = 0n

  for (const row of statement.iterate(...parameters)) {
    if (!Array.isArray(row)) {
      throw new TypeError(`Expected array rows in ${name}`)
    }

    hash.update('r')

    for (const value of row as unknown[]) {
      hashValue(hash, value, name)
    }

    count++
  }

  return count
}

function hashRecordBindings(db: Database, hash: Readonly<Pick<Hash, 'update'>>): void {
  hashField(hash, 'v', Buffer.from('wotlk-record-bindings-v1'))

  for (const { source_table } of db
    .prepare('SELECT DISTINCT source_table FROM record ORDER BY source_table COLLATE BINARY')
    .iterate()) {
    const table = String(source_table)
    const statement = db.prepare(
      `SELECT r.id, s.* FROM record r JOIN ${quoteIdentifier(table)} s ON s.rowid = r.source_row
        WHERE r.source_table = ? ORDER BY r.id COLLATE BINARY`
    )

    hashField(hash, 's', Buffer.from(table))
    hashRows(hash, statement, table, table)
  }
}

export function canonicalTableHash(db: Database, name: string): { hash: string; count: string } {
  const columns = db
    .prepare(`PRAGMA table_xinfo(${quoteIdentifier(name)})`)
    .all()
    .filter((column: Readonly<Record<string, unknown>>) => Number(column.hidden) === 0)
    .map((column: Readonly<Record<string, unknown>>) => String(column.name))
  const order = columns
    .map(
      (column) =>
        `typeof(${quoteIdentifier(column)}) COLLATE BINARY, ${quoteIdentifier(column)} COLLATE BINARY`
    )
    .join(', ')
  const statement = db.prepare(
    `SELECT ${columns.map((column) => quoteIdentifier(column)).join(', ')} FROM ${quoteIdentifier(name)} ORDER BY ${order}`
  )

  const hash = createHash('sha256')
  hashField(hash, 'v', Buffer.from('wotlk-table-v1'))

  for (const column of columns) {
    hashField(hash, 'c', Buffer.from(column))
  }

  const count = hashRows(hash, statement, name)

  if (name === 'record') {
    hashRecordBindings(db, hash)
  }

  return { count: count.toString(), hash: hash.digest('hex') }
}
