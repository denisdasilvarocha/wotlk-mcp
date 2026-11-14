import { DatabaseSync } from 'node:sqlite'

import { kinds } from './schema.js'

export function openReference(): DatabaseSync {
  const path = process.env.WOTLK_MCP_DB
  if (!path)
    throw new Error('no reference database: set WOTLK_MCP_DB to a compatible local database')
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    const version = row?.value
    if (typeof version !== 'string' || !/^1\.\d+\.\d+$/.test(version))
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
    throw new Error(
      `invalid WOTLK_MCP_DB: ${String(error).replace(/[\r\n]+/g, ' ')}; select a compatible reference database`,
      { cause: error }
    )
  }
}

export function getRecords(db: DatabaseSync, ids: string[]): string {
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
      if (
        (id.startsWith('fn:') || id.startsWith('method:')) &&
        db
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'lua_native_registration'"
          )
          .get()
      ) {
        const native = db
          .prepare(
            'SELECT va, context, registration_table, registration_index, call_sites, widget FROM lua_native_registration WHERE record_id = ? ORDER BY registration_table, registration_index, context'
          )
          .all(id)
        for (const fact of native) {
          let line = `native: ${String(fact.va)} ${String(fact.context)} ${String(fact.registration_table)}[${String(fact.registration_index)}] call sites ${String(fact.call_sites)}`
          if (fact.widget) line += ` widget ${String(fact.widget)}`
          lines.push(line)
        }
      }
      return lines.join('\n')
    })
    .join('\n\n')
}
