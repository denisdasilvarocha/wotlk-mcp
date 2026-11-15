import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createBrotliDecompress } from 'node:zlib'

import { canonicalTableHash } from '../build/table-hash.ts'
import { kinds, relations } from '../src/schema.ts'

let usedVersions: unknown = []
const args = process.argv.slice(2).filter((arg) => arg !== '--')
const prepare = args.includes('--prepare')
const allowShrink = args.includes('--allow-shrink')
const usedVersionsFile = args.find((arg) => arg.startsWith('--used-versions='))?.slice(16)
const options = args.filter((arg) => arg.startsWith('--'))

if (
  options.some(
    (arg) => !['--prepare', '--allow-shrink'].includes(arg) && !arg.startsWith('--used-versions=')
  )
)
  throw new Error('Unknown option')

const positional = args.filter((arg) => !arg.startsWith('--'))
const [database, asset, previous] = positional
let old: DatabaseSync | undefined

if (!database || (!prepare && !asset) || positional.length > 3)
  throw new Error(
    'Usage: release-gate <database> <asset.br> [previous.sqlite] [--prepare] [--allow-shrink] [--used-versions=versions.json]'
  )

if (usedVersionsFile !== undefined)
  usedVersions = JSON.parse(readFileSync(usedVersionsFile, 'utf8'))

if (!Array.isArray(usedVersions)) throw new Error('Invalid used versions')
const db = new DatabaseSync(database)

function tables(connection: DatabaseSync): string[] {
  return rows(
    connection,
    "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'meta' ORDER BY name COLLATE BINARY"
  ).map((row) => String(row.name))
}

function rows(
  connection: DatabaseSync,
  sql: string
): ReturnType<ReturnType<DatabaseSync['prepare']>['all']> {
  return connection.prepare(sql).all()
}

function pins(connection: DatabaseSync): string {
  const parsed = JSON.parse(metadata(connection, 'input_pins'))

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length)
    fail('Invalid input pins')

  return stable(parsed)
}

function metadata(connection: DatabaseSync, key: string): string {
  const value = connection.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value

  if (typeof value === 'string' && value) return value

  return fail(`Missing metadata ${key}`)
}

function fail(message: string): never {
  throw new Error(message)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`

  return JSON.stringify(value) ?? fail('Invalid input pin')
}

function counts(connection: DatabaseSync): Record<string, number> {
  const result: Record<string, number> = {}

  for (const name of schema(connection).keys())
    result[`table:${name}`] = scalar(connection, `SELECT count(*) FROM ${quote(name)}`)

  for (const row of rows(connection, 'SELECT kind, count(*) AS n FROM record GROUP BY kind'))
    result[`kind:${String(row.kind)}`] = Number(row.n)

  for (const row of rows(connection, 'SELECT relation, count(*) AS n FROM link GROUP BY relation'))
    result[`relation:${String(row.relation)}`] = Number(row.n)

  return result
}

function schema(connection: DatabaseSync): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>()
  const names = rows(
    connection,
    "SELECT name FROM pragma_table_list WHERE schema='main' AND type IN ('table','virtual') AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )

  for (const { name } of names) {
    const columns = rows(connection, `PRAGMA table_xinfo(${quote(String(name))})`)

    result.set(
      String(name),
      new Map(
        columns
          .filter((column) => Number(column.hidden) === 0)
          .map((column) => [String(column.name), String(column.type).toUpperCase()])
      )
    )
  }

  return result
}

function quote(s: string): string {
  return `"${s.replaceAll('"', '""')}"`
}

function scalar(connection: DatabaseSync, sql: string): number {
  return Number(Object.values(connection.prepare(sql).get() ?? {})[0])
}

function assertEmpty(sql: string, error: string): void {
  if (db.prepare(sql).get()) fail(error)
}

if (previous) old = new DatabaseSync(previous, { readOnly: true })
try {
  if (rows(db, 'PRAGMA integrity_check').some((row) => Object.values(row)[0] !== 'ok'))
    fail('SQLite integrity check failed')

  db.exec('SAVEPOINT fts_check')

  try {
    db.exec(
      "INSERT INTO record_fts(record_fts) VALUES('integrity-check'); INSERT INTO ui_line_fts(ui_line_fts) VALUES('integrity-check');"
    )
  } finally {
    db.exec('ROLLBACK TO fts_check; RELEASE fts_check')
  }

  assertEmpty(
    'SELECT id FROM record GROUP BY id HAVING count(*) <> 1 OR id IS NULL',
    'Duplicate or null Record ID'
  )
  assertEmpty(
    "SELECT id FROM record WHERE substr(id,1,length(kind)+1) <> kind || ':' OR length(id) <= length(kind)+1",
    'Invalid Record ID vocabulary'
  )

  const kindSet = new Set(
    rows(db, 'SELECT DISTINCT kind FROM record').map((row) => String(row.kind))
  )

  if (
    kinds.some((kind) => !kindSet.has(kind)) ||
    [...kindSet].some((kind) => !kinds.includes(kind))
  )
    fail('Record kind coverage or vocabulary failed')

  const relationSet = new Set(
    rows(db, 'SELECT DISTINCT relation FROM link').map((row) => String(row.relation))
  )
  const forwards = relations.map(([forward]) => forward)

  if (
    forwards.some((rel) => !relationSet.has(rel)) ||
    [...relationSet].some((rel) => !forwards.includes(rel))
  )
    fail('Link relation coverage or vocabulary failed')

  assertEmpty(
    'SELECT l.source_id FROM link l LEFT JOIN record s ON s.id=l.source_id LEFT JOIN record d ON d.id=l.destination_id WHERE s.id IS NULL OR d.id IS NULL LIMIT 1',
    'Missing Link endpoint'
  )

  const sourceTables = new Set(tables(db))

  for (const row of rows(db, 'SELECT DISTINCT source_table FROM record')) {
    const name = String(row.source_table)

    if (!sourceTables.has(name)) fail(`Missing source table ${name}`)

    if (
      db
        .prepare(
          `SELECT r.id FROM record r LEFT JOIN ${quote(name)} s ON s.rowid=r.source_row WHERE r.source_table=? AND s.rowid IS NULL LIMIT 1`
        )
        .get(name)
    )
      fail(`Unresolved source row in ${name}`)
  }

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

  if (scalar(db, 'SELECT count(*) FROM record') !== scalar(db, 'SELECT count(*) FROM record_fts'))
    fail('Record FTS count mismatch')

  assertEmpty(
    'SELECT path,line,text FROM ui_line EXCEPT SELECT path,line,text FROM ui_line_fts',
    'Interface FTS does not cover lines'
  )
  assertEmpty(
    'SELECT path,line,text FROM ui_line_fts EXCEPT SELECT path,line,text FROM ui_line',
    'Interface FTS has extra entries'
  )

  if (scalar(db, 'SELECT count(*) FROM ui_line') !== scalar(db, 'SELECT count(*) FROM ui_line_fts'))
    fail('Interface FTS count mismatch')

  if (!scalar(db, 'SELECT count(*) FROM source')) fail('Empty source manifest')

  const currentPins = pins(db)
  const currentCounts = counts(db)
  const declaredHashes = rows(
    db,
    "SELECT key,value FROM meta WHERE key LIKE 'canonical_hash.%' OR key LIKE 'canonical_count.%'"
  )
  const declarations = new Map(declaredHashes.map((row) => [String(row.key), String(row.value)]))

  if (declarations.size !== sourceTables.size * 2) fail('Incomplete canonical hash metadata')

  for (const name of sourceTables) {
    const { hash, count } = canonicalTableHash(db, name)

    if (
      declarations.get(`canonical_hash.${name}`) !== hash ||
      declarations.get(`canonical_count.${name}`) !== count
    )
      fail(`Invalid canonical hash or count: ${name}`)
  }

  let change = 'first'
  let version = '1.0.0'

  if (old && previous) {
    let breaking = false,
      addition = false
    const previousVersion = metadata(old, 'schema_version')
    const match =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(previousVersion) ??
      fail('Invalid previous schema version')
    const before = schema(old),
      after = schema(db)

    for (const [name, columns] of before) {
      const next = after.get(name)

      if (!next) {
        breaking = true
        continue
      }

      for (const [column, type] of columns) if (next.get(column) !== type) breaking = true

      for (const column of next.keys()) if (!columns.has(column)) addition = true
    }

    for (const name of after.keys()) if (!before.has(name)) addition = true

    const oldKinds = new Set(
      rows(old, 'SELECT DISTINCT kind FROM record').map((row) => String(row.kind))
    )

    for (const kind of oldKinds) if (!kindSet.has(kind)) breaking = true

    for (const kind of kindSet) if (!oldKinds.has(kind)) addition = true

    if (before.has('record') && after.has('record')) {
      db.prepare('ATTACH DATABASE ? AS previous_gate').run(previous)

      try {
        const sources = rows(db, 'SELECT DISTINCT source_table FROM record')

        for (const { source_table } of sources) {
          const table = String(source_table)
          const columns = after.get(table)
          const oldColumns = before.get(table)

          if (!columns || !oldColumns) continue

          const key = ['ID', 'entry', 'path', 'command', 'name'].find(
            (name) => columns.has(name) && oldColumns.has(name)
          )

          if (!key) continue

          const keys = [key]

          if (table === 'lua_method' && columns.has('declaringWidget')) keys.push('declaringWidget')

          const equal = keys.map((name) => `s.${quote(name)} IS t.${quote(name)}`).join(' AND ')

          if (
            db
              .prepare(`SELECT 1 FROM previous_gate.record p
            JOIN previous_gate.${quote(table)} s ON s.rowid=p.source_row
            JOIN main.${quote(table)} t ON ${equal}
            JOIN main.record c ON c.source_row=t.rowid AND c.source_table=p.source_table AND c.kind=p.kind
            WHERE p.source_table=? AND c.id<>p.id LIMIT 1`)
              .get(table)
          )
            breaking = true
        }
      } finally {
        db.exec('DETACH DATABASE previous_gate')
      }
    }

    const [major, minor, patch] = match.slice(1).map(Number)

    change = 'patch'
    version = `${major}.${minor}.${patch + 1}`

    if (breaking) {
      change = 'major'
      version = `${major + 1}.0.0`
    } else if (addition) {
      change = 'minor'
      version = `${major}.${minor + 1}.0`
    }

    const previousCounts = counts(old)

    if (!allowShrink)
      for (const [key, count] of Object.entries(previousCounts))
        if ((currentCounts[key] ?? 0) * 100 < count * 95) fail(`Excessive shrink: ${key}`)

    if (currentPins === pins(old)) {
      const beforeTables = tables(old),
        afterTables = tables(db)

      if (JSON.stringify(beforeTables) !== JSON.stringify(afterTables))
        fail('Unchanged input pins with logical drift')

      for (const name of afterTables)
        if (canonicalTableHash(db, name).hash !== canonicalTableHash(old, name).hash)
          fail(`Unchanged input pins with logical drift: ${name}`)
    }
  }

  let [major, minor, patch] = version.split('.').map(Number)

  for (const used of usedVersions) {
    if (typeof used !== 'string') fail('Invalid used version')

    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(used)

    if (!match) fail('Invalid used version')

    const [usedMajor, usedMinor, usedPatch] = match.slice(1).map(Number)

    if (usedMajor === major && (usedMinor > minor || (usedMinor === minor && usedPatch >= patch))) {
      minor = usedMinor
      patch = usedPatch + 1
    }
  }

  version = `${major}.${minor}.${patch}`

  if (prepare) db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(version)
  else if (metadata(db, 'schema_version') !== version)
    fail(
      `Insufficient or incorrect schema version; required ${version}; run --prepare and recompress`
    )

  db.close()
  old?.close()

  let compressedBytes: number | undefined

  if (!prepare) {
    compressedBytes = statSync(asset).size

    if (compressedBytes > 250_000_000) fail('Compressed asset exceeds 250 MB')

    const actual = createHash('sha256'),
      decoded = createHash('sha256')

    for await (const chunk of createReadStream(database)) actual.update(chunk)

    for await (const chunk of createReadStream(asset).pipe(createBrotliDecompress()))
      decoded.update(chunk)

    if (actual.digest('hex') !== decoded.digest('hex'))
      fail('Compressed asset does not contain the candidate database')
  }

  console.log(
    JSON.stringify({
      version,
      change,
      counts: currentCounts,
      compressed_bytes: compressedBytes,
      uncompressed_bytes: statSync(database).size,
      allow_shrink: allowShrink
    })
  )
} finally {
  if (db.isOpen) db.close()

  if (old?.isOpen) old.close()
}
