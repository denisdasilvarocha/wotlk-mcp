import { linkWriter } from '../links/insert.ts'
import { declaringWidget } from './widget.ts'

import type { Database } from '../../src/database.ts'
import type { Registration, TableDecision } from './registration.ts'

type Lookup = { readonly get: (key: string) => readonly string[] | undefined }

type Resolution = {
  readonly widgets: Lookup
  readonly parents: Lookup
  readonly inherited: Lookup
  readonly resolved: { readonly get: (key: string) => string | undefined }
}
type Decisions = Readonly<Record<string, TableDecision | undefined>>

function registrationIdentity(
  row: Registration,
  overrides: Decisions,
  resolution: Resolution
): readonly [string, string | undefined] {
  const { widgets, parents, inherited, resolved } = resolution
  let id = ''
  let widget: string | undefined
  if (row.kind === 'global') {
    id = `fn:${row.name}`
  }
  if (row.kind === 'method') {
    widget = resolved.get(row.table)
    let declaring: string | undefined
    if (widget !== undefined && widget !== '' && overrides[row.table]?.exact_inheritance !== true) {
      declaring = declaringWidget(widget, row.name, widgets, inherited, parents)
    } else if (
      widget !== undefined &&
      widget !== '' &&
      widgets.get(widget)?.includes(row.name) === true
    ) {
      declaring = widget
    }
    if (declaring !== undefined && declaring !== '') {
      id = `method:${declaring}:${row.name}`
    }
  }
  return [id, widget]
}

export function insertRegistrations(
  db: Database,
  rows: readonly Registration[],
  overrides: Decisions,
  resolution: Resolution
): void {
  db.exec(
    `CREATE TABLE lua_native_registration (kind TEXT NOT NULL, name TEXT NOT NULL, va TEXT NOT NULL, context TEXT NOT NULL, registration_table TEXT NOT NULL, registration_index INTEGER NOT NULL, call_sites TEXT NOT NULL, widget TEXT, record_id TEXT REFERENCES record(id)); CREATE INDEX lua_native_record ON lua_native_registration(record_id)`
  )

  const insert = db.prepare(
    "INSERT INTO lua_native_registration VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''))"
  )
  const exists = db.prepare('SELECT 1 FROM record WHERE id = ?')
  const offsets = db.prepare('SELECT path FROM offsets_entry WHERE va = ? ORDER BY path')
  const addLink = linkWriter(db)

  for (const row of rows) {
    const [id, widget] = registrationIdentity(row, overrides, resolution)

    let record = ''

    if (exists.get(id)) {
      record = id
    }
    insert.run(
      row.kind,
      row.name,
      row.va,
      row.context,
      row.table,
      row.index,
      JSON.stringify(row.call_sites),
      widget ?? '',
      record
    )

    let note = `${row.context} ${row.table}[${row.index}] ${row.va}`

    if (widget !== undefined && widget !== '') {
      note += ` widget ${widget}`
    }

    if (record) {
      for (const offset of offsets.all(row.va)) {
        addLink(record, 'implemented by', `offset:${String(offset.path)}`, note)
      }
    }
  }
}
