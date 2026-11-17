import { quoteIdentifier } from '../shared/table-hash.ts'
import { createHash, type Hash } from 'node:crypto'

import type { Database } from '../../src/database.ts'
import type { Column, Value } from './data.ts'
import type { StatementSync } from 'node:sqlite'

interface ExportContext {
  readonly db: Database
  readonly hashRow: (
    hash: Readonly<Pick<Hash, 'update'>>,
    columns: readonly Column[],
    values: readonly unknown[]
  ) => asserts values is readonly Value[]
  readonly metadata: Readonly<Pick<StatementSync, 'run'>>
  readonly mysql: (query: string) => Promise<string>
  readonly scan: (
    query: string,
    table: string,
    columns: readonly Column[],
    consume: (values: readonly unknown[]) => void
  ) => Promise<void>
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

async function scanTable(
  context: Readonly<ExportContext>,
  query: string,
  table: string,
  columns: readonly Column[],
  insert?: Readonly<Pick<StatementSync, 'run'>>
): Promise<{ count: bigint; hash: Hash }> {
  let count = 0n
  const hash = createHash('sha256')

  await context.scan(query, table, columns, (values) => {
    context.hashRow(hash, columns, values)
    insert?.run(...values)
    count++
  })

  return { count, hash }
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

  const hash = createHash('sha256')

  for (const row of select.iterate()) {
    context.hashRow(
      hash,
      columns,
      columns.map(({ name }) => row[name])
    )
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
  const query = exportQuery(table, columns)
  const countText = (await context.mysql(`SELECT COUNT(*) FROM ${quoteMy(table)}`)).trim()

  if (!/^\d+$/u.test(countText)) {
    throw new Error(`Invalid source count for ${table}`)
  }

  const expectedCount = BigInt(countText)
  const source = await scanTable(context, query, table, columns)

  createTable(context.db, destination, columns)

  const insert = context.db.prepare(
    `INSERT INTO ${quoteIdentifier(destination)} (${columns.map(({ name }) => quoteIdentifier(name)).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
  )
  const exported = await scanTable(context, query, table, columns, insert)
  const sqlite = hashSqlite(context, destination, columns)
  const sourceDigest = source.hash.digest('hex')

  if (
    source.count !== expectedCount ||
    exported.count !== expectedCount ||
    sqlite.count !== expectedCount ||
    exported.hash.digest('hex') !== sourceDigest ||
    sqlite.hash.digest('hex') !== sourceDigest
  ) {
    throw new Error(`World data count or logical hash mismatch in ${table}`)
  }

  context.metadata.run(`hash.${destination}`, sourceDigest)
  context.metadata.run(`count.${destination}`, countText)
}
