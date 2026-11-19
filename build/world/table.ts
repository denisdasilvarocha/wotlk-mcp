import { quoteIdentifier } from '../shared/table-hash.ts'
import { hashRow } from './data.ts'
import { createHash, type Hash } from 'node:crypto'

import type { Database } from '../../src/database.ts'
import type { Column } from './data.ts'
import type { StatementSync } from 'node:sqlite'

interface ExportContext {
  readonly db: Database
  readonly metadata: Readonly<Pick<StatementSync, 'run'>>
  readonly scan: (
    query: string,
    table: string,
    columns: readonly Column[],
    consume: (values: readonly unknown[]) => void
  ) => Promise<bigint>
}

function quoteMy(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``
}

function exportQuery(table: string, columns: readonly Column[]): string {
  const expressions = columns.map(({ name, kind }) => {
    const col = quoteMy(name)
    let value = col

    if (kind === 'real') {
      value = `CAST(${col} AS DOUBLE)`
    }

    return `IF(${col} IS NULL,'N',CONCAT('V',HEX(CAST(${value} AS BINARY))))`
  })
  const encoded = expressions.join(',')

  return `SELECT ${encoded} FROM ${quoteMy(table)} ORDER BY SHA2(CONCAT_WS(':',${encoded}),256),${expressions.map((e) => `BINARY ${e}`).join(',')}`
}

function createTable(db: Database, destination: string, columns: readonly Column[]): void {
  db.exec(
    `CREATE TABLE ${quoteIdentifier(destination)} (${columns
      .map(({ name, kind }) => {
        let type = 'TEXT'

        if (kind === 'integer') {
          type = 'INTEGER'
        } else if (kind === 'real') {
          type = 'REAL'
        } else if (kind === 'blob') {
          type = 'BLOB'
        }

        return `${quoteIdentifier(name)} ${type}`
      })
      .join(', ')})`
  )
}

function hashSqlite(
  context: Readonly<ExportContext>,
  destination: string,
  columns: readonly Column[]
): { count: bigint; hash: Hash } {
  const select = context.db.prepare(
    `SELECT ${columns.map(({ name }) => quoteIdentifier(name)).join(',')} FROM ${quoteIdentifier(destination)} ORDER BY rowid`
  )
  let count = 0n

  select.setReadBigInts(true)
  select.setReturnArrays(true)

  const hash = createHash('sha256')

  for (const row of select.iterate()) {
    if (!Array.isArray(row)) {
      throw new TypeError(`Expected array rows in ${destination}`)
    }

    hashRow(hash, columns, row as unknown[])
    count++
  }

  return { count, hash }
}

export async function exportTable(
  context: Readonly<ExportContext>,
  table: string,
  columns: readonly Column[]
): Promise<void> {
  const destination = `world_${table}`
  const tableName = Buffer.from(table).toString('hex')
  const query = `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY; SELECT IF((SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONVERT(0x${tableName} USING utf8mb4)) = 'InnoDB', COUNT(*), 'non-InnoDB') FROM ${quoteMy(table)}; ${exportQuery(table, columns)}; COMMIT`

  createTable(context.db, destination, columns)

  const insert = context.db.prepare(
    `INSERT INTO ${quoteIdentifier(destination)} (${columns.map(({ name }) => quoteIdentifier(name)).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
  )
  const hash = createHash('sha256')
  let count = 0n
  const expectedCount = await context.scan(query, table, columns, (values) => {
    hashRow(hash, columns, values)
    insert.run(...values)
    count++
  })
  const sqlite = hashSqlite(context, destination, columns)
  const sourceDigest = hash.digest('hex')

  if (
    count !== expectedCount ||
    sqlite.count !== expectedCount ||
    sqlite.hash.digest('hex') !== sourceDigest
  ) {
    throw new Error(`World data count or logical hash mismatch in ${table}`)
  }

  context.metadata.run(`hash.${destination}`, sourceDigest)
  context.metadata.run(`count.${destination}`, expectedCount.toString())
}
