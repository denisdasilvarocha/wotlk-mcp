import type { DatabaseSync } from 'node:sqlite'

import { quoteIdentifier } from '../build/table-hash.ts'
import type { Database } from '../src/database.ts'
import { kinds, relations } from '../src/schema.ts'
export function rows(
  connection: Database,
  sql: string
): readonly Readonly<ReturnType<ReturnType<DatabaseSync['prepare']>['all']>[number]>[] {
  return connection.prepare(sql).all()
}

export function pins(connection: Database): string {
  const parsed: unknown = JSON.parse(metadata(connection, 'input_pins'))

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length === 0
  ) {
    fail('Invalid input pins')
  }

  return stable(parsed)
}

export function metadata(connection: Database, key: string): string {
  const value = connection.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value

  if (typeof value === 'string' && value) {
    return value
  }

  return fail(`Missing metadata ${key}`)
}

export function fail(message: string): never {
  throw new Error(message)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => stable(item)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([a]: readonly [string, unknown], [b]: readonly [string, unknown]) =>
        a.localeCompare(b)
      )
      .map(([k, v]: readonly [string, unknown]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`
  }

  return JSON.stringify(value) ?? fail('Invalid input pin')
}

export function counts(connection: Database): Record<string, number> {
  const result: Record<string, number> = {}

  for (const name of schema(connection).keys()) {
    result[`table:${name}`] = scalar(connection, `SELECT count(*) FROM ${quoteIdentifier(name)}`)
  }

  for (const row of rows(connection, 'SELECT kind, count(*) AS n FROM record GROUP BY kind')) {
    result[`kind:${String(row.kind)}`] = Number(row.n)
  }

  for (const row of rows(
    connection,
    'SELECT relation, count(*) AS n FROM link GROUP BY relation'
  )) {
    result[`relation:${String(row.relation)}`] = Number(row.n)
  }

  return result
}

export function schema(connection: Database): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>()
  const names = rows(
    connection,
    "SELECT name FROM pragma_table_list WHERE schema='main' AND type IN ('table','virtual') AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )

  for (const { name } of names) {
    const columns = rows(connection, `PRAGMA table_xinfo(${quoteIdentifier(String(name))})`)

    result.set(
      String(name),
      new Map(
        columns
          .filter((column: Readonly<Record<string, unknown>>) => Number(column.hidden) === 0)
          .map((column: Readonly<Record<string, unknown>>) => [
            String(column.name),
            String(column.type).toUpperCase()
          ])
      )
    )
  }

  return result
}

function scalar(connection: Database, sql: string): number {
  return Number(Object.values(connection.prepare(sql).get() ?? {})[0])
}

export function checkVocabulary(
  db: Database,
  assertEmpty: (sql: string, error: string) => void
): Set<string> {
  checkIntegrity(db)
  assertEmpty(
    'SELECT id FROM record GROUP BY id HAVING count(*) <> 1 OR id IS NULL',
    'Duplicate or null Record ID'
  )

  assertEmpty(
    "SELECT id FROM record WHERE substr(id,1,length(kind)+1) <> kind || ':' OR length(id) <= length(kind)+1",
    'Invalid Record ID vocabulary'
  )

  const kindSet = new Set(
    rows(db, 'SELECT DISTINCT kind FROM record').map((row: Readonly<Record<string, unknown>>) =>
      String(row.kind)
    )
  )

  if (
    kinds.some((kind) => !kindSet.has(kind)) ||
    [...kindSet].some((kind) => !kinds.includes(kind))
  ) {
    fail('Record kind coverage or vocabulary failed')
  }

  const relationSet = new Set(
    rows(db, 'SELECT DISTINCT relation FROM link').map((row: Readonly<Record<string, unknown>>) =>
      String(row.relation)
    )
  )
  const forwards = relations.map(([forward]: readonly string[]) => forward)

  if (
    forwards.some((rel) => !relationSet.has(rel)) ||
    [...relationSet].some((rel) => !forwards.includes(rel))
  ) {
    fail('Link relation coverage or vocabulary failed')
  }

  assertEmpty(
    'SELECT l.source_id FROM link l LEFT JOIN record s ON s.id=l.source_id LEFT JOIN record d ON d.id=l.destination_id WHERE s.id IS NULL OR d.id IS NULL LIMIT 1',
    'Missing Link endpoint'
  )

  return kindSet
}

export function checkSources(
  db: Database,
  sourceTables: Readonly<Pick<ReadonlySet<string>, 'has'>>
): void {
  for (const row of rows(db, 'SELECT DISTINCT source_table FROM record')) {
    const name = String(row.source_table)

    if (!sourceTables.has(name)) {
      fail(`Missing source table ${name}`)
    }

    if (
      db
        .prepare(
          `SELECT r.id FROM record r LEFT JOIN ${quoteIdentifier(name)} s ON s.rowid=r.source_row WHERE r.source_table=? AND s.rowid IS NULL LIMIT 1`
        )
        .get(name)
    ) {
      fail(`Unresolved source row in ${name}`)
    }
  }
}

export function checkFullText(
  db: Database,
  assertEmpty: (sql: string, error: string) => void
): void {
  assertEmpty(
    "SELECT l.source_id FROM link l JOIN record o ON o.id=l.destination_id LEFT JOIN offsets_entry e ON o.source_table='offsets_entry' AND e.rowid=o.source_row WHERE l.relation='implemented by' AND (e.rowid IS NULL OR NOT EXISTS (SELECT 1 FROM lua_native_registration n WHERE n.record_id=l.source_id AND n.va=e.va)) LIMIT 1",
    'Missing equal-VA native evidence'
  )
  assertEmpty(
    'SELECT id,name,search_text FROM record EXCEPT SELECT id,name,text FROM record_fts',
    'Record FTS does not cover Records'
  )
  assertEmpty(
    'SELECT id,name,text FROM record_fts EXCEPT SELECT id,name,search_text FROM record',
    'Record FTS has extra entries'
  )

  if (scalar(db, 'SELECT count(*) FROM record') !== scalar(db, 'SELECT count(*) FROM record_fts')) {
    fail('Record FTS count mismatch')
  }

  assertEmpty(
    'SELECT path,line,text FROM ui_line EXCEPT SELECT path,line,text FROM ui_line_fts',
    'Interface FTS does not cover lines'
  )
  assertEmpty(
    'SELECT path,line,text FROM ui_line_fts EXCEPT SELECT path,line,text FROM ui_line',
    'Interface FTS has extra entries'
  )

  if (
    scalar(db, 'SELECT count(*) FROM ui_line') !== scalar(db, 'SELECT count(*) FROM ui_line_fts')
  ) {
    fail('Interface FTS count mismatch')
  }

  if (!scalar(db, 'SELECT count(*) FROM source')) {
    fail('Empty source manifest')
  }
}

function checkIntegrity(db: Database): void {
  if (
    rows(db, 'PRAGMA integrity_check').some(
      (row: Readonly<Record<string, unknown>>) => Object.values(row)[0] !== 'ok'
    )
  ) {
    fail('SQLite integrity check failed')
  }
  db.exec('SAVEPOINT fts_check')
  try {
    db.exec(
      "INSERT INTO record_fts(record_fts) VALUES('integrity-check'); INSERT INTO ui_line_fts(ui_line_fts) VALUES('integrity-check');"
    )
  } finally {
    db.exec('ROLLBACK TO fts_check; RELEASE fts_check')
  }
}
