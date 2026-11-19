import { acceptedSchemaMajor } from './schema.js'
import { DatabaseSync } from 'node:sqlite'

import type { Database } from './database.js'
import type { SQLOutputValue } from 'node:sqlite'

type SqlRow = Readonly<Record<string, SQLOutputValue>>

function renderFileWindow(db: Database, id: string, row: SqlRow, from: number, to: number): string {
  const path = id.slice(id.indexOf(':') + 1)
  const total = Number(
    db.prepare('SELECT count(*) AS total FROM ui_line WHERE path = ?').get(path)?.total
  )
  const rows = db
    .prepare('SELECT line, text FROM ui_line WHERE path = ? AND line BETWEEN ? AND ? ORDER BY line')
    .all(path, from, to)
  const lines = [id]

  if (row.locale) {
    lines.push(`locale: ${String(row.locale)}`)
  }
  if (row.provenance) {
    lines.push(`provenance: ${String(row.provenance)}`)
  }
  lines.push(...rows.map((line) => `${String(line.line)}: ${String(line.text)}`))

  const start = Number(rows[0]?.line ?? 0)
  const end = Number(rows.at(-1)?.line ?? 0)

  lines.push(`${start}–${end} of ${total}; ${end && end < total ? `next from: ${end + 1}` : 'end'}`)

  return lines.join('\n')
}

function renderEnumValue(
  value: number,
  entries: readonly Readonly<Record<string, unknown>>[],
  flags: boolean
): string {
  if (!flags) {
    const entry = entries.find((candidate) => candidate.value === value)

    return entry ? `${value} (${String(entry.name)})` : String(value)
  }

  const names: string[] = []
  let remaining = BigInt(value)

  // DBC flag columns are signed int32; bit 31 makes them negative.
  if (remaining < 0n) {
    remaining = BigInt.asUintN(32, remaining)
  }

  for (const entry of entries) {
    const bit = BigInt(Number(entry.value))

    if (bit > 0n && (bit & (bit - 1n)) === 0n && (remaining & bit) === bit) {
      names.push(String(entry.name))
      remaining &= ~bit
    }
  }

  if (names.length === 0) {
    return String(value)
  }
  if (remaining) {
    names.push(remaining.toString())
  }

  return `${value} (${names.join(', ')})`
}

function renderFields(db: Database, table: string, row: SqlRow, identifier: string): string[] {
  const fields = db
    .prepare(
      'SELECT field, enum_name, flags, condition_field, condition_value FROM enum_field WHERE source_table = ?'
    )
    .all(table)
  const values = db.prepare(
    'SELECT value, name FROM enum_value WHERE enum_name = ? ORDER BY value, name'
  )
  const lines: string[] = []

  for (const [key, value] of Object.entries(row)) {
    if (
      value === null ||
      value === '' ||
      value === 0 ||
      ((key.toLowerCase() === 'id' || key.toLowerCase() === 'name' || key === 'path') &&
        String(value) === identifier)
    ) {
      continue
    }

    let rendered = String(value)
    const mapping = fields.find(
      (field) =>
        field.field === key &&
        (field.condition_field === null ||
          row[String(field.condition_field)] === field.condition_value)
    )

    if (mapping && typeof value === 'number' && Number.isSafeInteger(value) && value !== -1) {
      rendered = renderEnumValue(
        value,
        values.all(String(mapping.enum_name)),
        Boolean(mapping.flags)
      )
    }

    lines.push(`${key}: ${rendered.replaceAll(/\r?\n/gu, '\n  ')}`)
  }

  return lines
}

function nativeFacts(db: Database, id: string): string[] {
  if (
    (!id.startsWith('fn:') && !id.startsWith('method:')) ||
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'lua_native_registration'"
      )
      .get()
  ) {
    return []
  }

  return db
    .prepare(
      'SELECT va, context, registration_table, registration_index, call_sites, widget FROM lua_native_registration WHERE record_id = ? ORDER BY registration_table, registration_index, context'
    )
    .all(id)
    .map(
      (fact) =>
        `native: ${String(fact.va)} ${String(fact.context)} ${String(fact.registration_table)}[${String(fact.registration_index)}] call sites ${String(fact.call_sites)}${fact.widget ? ` widget ${String(fact.widget)}` : ''}`
    )
}

function getRecord(db: Database, id: string, from: number, to: number): string {
  const record = db.prepare('SELECT source_table, source_row FROM record WHERE id = ?').get(id)

  if (!record) {
    return `not found: ${id}`
  }

  const table = String(record.source_table)

  if (!/^(dbc|world|lua|offsets|ui)_[A-Za-z0-9_]+$/u.test(table)) {
    throw new Error(`invalid source table for ${id}`)
  }

  const row = db.prepare(`SELECT * FROM "${table}" WHERE rowid = ?`).get(Number(record.source_row))

  if (!row) {
    throw new Error(`missing source row for ${id}; rebuild the reference database`)
  }
  if (id.startsWith('file:')) {
    return renderFileWindow(db, id, row, from, Math.min(to, from + 199))
  }

  return [
    id,
    ...renderFields(db, table, row, id.slice(id.indexOf(':') + 1)),
    ...nativeFacts(db, id)
  ].join('\n')
}

export function validateReference(db: Database): void {
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value

  if (
    typeof version !== 'string' ||
    !new RegExp(`^${acceptedSchemaMajor}\\.\\d+\\.\\d+$`, 'u').test(version)
  ) {
    throw new Error(
      `incompatible schema version ${String(version)}; use wotlk-mcp matching the database major`
    )
  }

  db.prepare(
    'SELECT id, kind, name, source_table, source_row, search_text, hint FROM record LIMIT 0'
  ).all()
  db.prepare('SELECT source_id, relation, destination_id, notes FROM link LIMIT 0').all()
  db.prepare('SELECT id, name, text FROM record_fts LIMIT 0').all()
  db.prepare('SELECT path, line, text FROM ui_line_fts LIMIT 0').all()
  if (db.prepare("SELECT 1 FROM record WHERE kind = 'file' LIMIT 1").get()) {
    db.prepare('SELECT rowid, path FROM ui_file LIMIT 0').all()
    db.prepare('SELECT path, line, text FROM ui_line LIMIT 0').all()
  }
  db.prepare('SELECT enum_name, value, name FROM enum_value LIMIT 0').all()
  db.prepare(
    'SELECT source_table, field, enum_name, flags, condition_field, condition_value FROM enum_field LIMIT 0'
  ).all()
  db.prepare('SELECT name, pin, sha256, licence, attribution FROM source LIMIT 0').all()
}

export function openReference(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true })

  try {
    validateReference(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function getRecords(
  db: Database,
  ids: readonly string[],
  from = 1,
  to = from + 199
): string {
  if (to < from) {
    throw new Error('get requires to ≥ from')
  }

  return ids.map((id) => getRecord(db, id, from, to)).join('\n\n')
}
