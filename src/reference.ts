import { DatabaseSync } from 'node:sqlite'

import { acceptedSchemaMajor, kinds } from './schema.js'

export function openReference(path: string): DatabaseSync {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    const version = row?.value
    if (
      typeof version !== 'string' ||
      !new RegExp(`^${acceptedSchemaMajor}\\.\\d+\\.\\d+$`).test(version)
    )
      throw new Error(
        `incompatible schema version ${String(version)}; use wotlk-mcp matching the database major`
      )
    db.prepare('SELECT id, kind, name, source_table, source_row FROM record LIMIT 0').all()
    db.prepare('SELECT source_id, relation, destination_id, notes FROM link LIMIT 0').all()
    db.prepare('SELECT id, name, text FROM record_fts LIMIT 0').all()
    db.prepare('SELECT path, line, text FROM ui_line_fts LIMIT 0').all()
    db.prepare('SELECT enum_name, value, name FROM enum_value LIMIT 0').all()
    db.prepare(
      'SELECT source_table, field, enum_name, flags, condition_field, condition_value FROM enum_field LIMIT 0'
    ).all()
    db.prepare('SELECT name, pin, sha256, licence, attribution FROM source LIMIT 0').all()
    return db
  } catch (error) {
    db?.close()
    throw error
  }
}

export function getRecords(db: DatabaseSync, ids: string[], from = 1, to = from + 199): string {
  if (to < from) throw new Error('get requires to ≥ from')
  const index = db.prepare('SELECT name, source_table, source_row FROM record WHERE id = ?')
  return ids
    .map((id) => {
      const colon = id.indexOf(':')
      if (colon < 1 || colon === id.length - 1 || !kinds.includes(id.slice(0, colon)))
        throw new Error(`invalid ID ${id}; valid kinds: ${kinds.join(', ')}`)
      const record = index.get(id)
      if (!record) return `not found: ${id}`
      const table = String(record.source_table)
      if (!/^(dbc|world|lua|offsets|ui)_[A-Za-z0-9_]+$/.test(table))
        throw new Error(`invalid source table for ${id}`)
      const row = db
        .prepare(`SELECT * FROM "${table}" WHERE rowid = ?`)
        .get(Number(record.source_row))
      if (!row) throw new Error(`missing source row for ${id}; rebuild the reference database`)
      if (id.startsWith('file:')) {
        const path = id.slice(colon + 1)
        const total = Number(
          db.prepare('SELECT count(*) AS total FROM ui_line WHERE path = ?').get(path)?.total
        )
        const rows = db
          .prepare(
            'SELECT line, text FROM ui_line WHERE path = ? AND line BETWEEN ? AND ? ORDER BY line'
          )
          .all(path, from, to)
        const lines = [id]
        if (row.locale) lines.push(`locale: ${String(row.locale)}`)
        if (row.provenance) lines.push(`provenance: ${String(row.provenance)}`)
        lines.push(...rows.map((line) => `${String(line.line)}: ${String(line.text)}`))
        const start = Number(rows[0]?.line ?? 0)
        const end = Number(rows.at(-1)?.line ?? 0)
        let continuation = 'end'
        if (end && end < total) continuation = `next from: ${end + 1}`
        lines.push(`${start}–${end} of ${total}; ${continuation}`)
        return lines.join('\n')
      }
      const lines = [id]
      for (const [key, value] of Object.entries(row)) {
        if (
          value === null ||
          value === '' ||
          value === 0 ||
          ((key.toLowerCase() === 'id' || key.toLowerCase() === 'name' || key === 'path') &&
            String(value) === id.slice(colon + 1))
        )
          continue
        lines.push(`${key}: ${String(value).replace(/\r?\n/g, '\n  ')}`)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}
