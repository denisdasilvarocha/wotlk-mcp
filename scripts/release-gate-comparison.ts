import { quoteIdentifier } from '../build/shared/table-hash.ts'
import { rows } from './release-gate-checks.ts'

import type { Database } from '../src/database.ts'

type Schema = Readonly<
  Pick<
    ReadonlyMap<
      string,
      Readonly<Pick<ReadonlyMap<string, string>, 'get' | 'has' | 'keys' | typeof Symbol.iterator>>
    >,
    'get' | 'has' | 'keys' | typeof Symbol.iterator
  >
>

type Names = Readonly<Pick<ReadonlySet<string>, 'has' | typeof Symbol.iterator>>

function compareKinds(old: Database, kindSet: Names): { addition: boolean; breaking: boolean } {
  const oldKinds = new Set(
    rows(old, 'SELECT DISTINCT kind FROM record').map((row: Readonly<Record<string, unknown>>) =>
      String(row.kind)
    )
  )
  return {
    addition: [...kindSet].some((kind) => !oldKinds.has(kind)),
    breaking: [...oldKinds].some((kind) => !kindSet.has(kind))
  }
}

function recordIdChanged(db: Database, table: string, keys: readonly string[]): boolean {
  const columns = keys.map((name) => quoteIdentifier(name))
  const oldKeys = columns.map((name) => `s.${name}`).join(', ')
  const newKeys = columns.map((name) => `t.${name}`).join(', ')
  const equal = columns.map((name) => `s.${name} IS t.${name}`).join(' AND ')

  return (
    db
      .prepare(`WITH old_records AS MATERIALIZED (
              SELECT p.id AS record_id, p.kind AS record_kind, ${oldKeys}
              FROM previous_gate.record p
              JOIN previous_gate.${quoteIdentifier(table)} s ON s.rowid=p.source_row
              WHERE p.source_table=?
            ), new_records AS MATERIALIZED (
              SELECT c.id AS record_id, c.kind AS record_kind, ${newKeys}
              FROM main.record c
              JOIN main.${quoteIdentifier(table)} t ON t.rowid=c.source_row
              WHERE c.source_table=?
            )
            SELECT 1 FROM old_records s
            JOIN new_records t ON ${equal} AND s.record_kind=t.record_kind
            WHERE s.record_id<>t.record_id LIMIT 1`)
      .get(table, table) !== undefined
  )
}

export function compareSchemas(
  before: Schema,
  after: Schema,
  old: Database,
  kindSet: Names
): { addition: boolean; breaking: boolean } {
  let addition = false
  let breaking = false
  for (const [name, columns] of before) {
    const next = after.get(name)

    if (!next) {
      breaking = true
      continue
    }

    for (const [column, type] of columns) {
      if (next.get(column) !== type) {
        breaking = true
      }
    }

    for (const column of next.keys()) {
      if (!columns.has(column)) {
        addition = true
      }
    }
  }

  for (const name of after.keys()) {
    if (!before.has(name)) {
      addition = true
    }
  }

  const kinds = compareKinds(old, kindSet)
  addition ||= kinds.addition
  breaking ||= kinds.breaking
  return { addition, breaking }
}

export function changedRecordIds(
  db: Database,
  previous: string,
  before: Schema,
  after: Schema
): boolean {
  if (!before.has('record') || !after.has('record')) {
    return false
  }
  let breaking = false
  db.prepare('ATTACH DATABASE ? AS previous_gate').run(previous)
  try {
    const sources = rows(db, 'SELECT DISTINCT source_table FROM record')

    for (const { source_table } of sources) {
      const table = String(source_table)
      const columns = after.get(table)
      const oldColumns = before.get(table)

      if (!columns || !oldColumns) {
        continue
      }

      const key = ['ID', 'entry', 'path', 'command', 'name'].find(
        (name) => columns.has(name) && oldColumns.has(name)
      )

      if (key === undefined || key === '') {
        continue
      }

      const keys = [key]

      if (table === 'lua_method' && columns.has('declaringWidget')) {
        keys.push('declaringWidget')
      }

      if (recordIdChanged(db, table, keys)) {
        breaking = true
      }
    }
  } finally {
    db.exec('DETACH DATABASE previous_gate')
  }
  return breaking
}
