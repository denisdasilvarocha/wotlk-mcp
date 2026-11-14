import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { addLink } from '../src/links.js'

const [database, directory, manifestHash, overridePath] = process.argv
  .slice(2)
  .filter((arg) => arg !== '--')
if (!database || !directory || !manifestHash)
  throw new Error(
    'Usage: vpx scripts/import-native.ts <database> <client-inputs> <manifest-sha256> [overrides.json]'
  )
function sha(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function sorted(names: string[]): string {
  return JSON.stringify([...new Set(names)].toSorted())
}
const manifestText = readFileSync(path.join(directory, 'manifest.json'), 'utf8')
if (!/^[a-f0-9]{64}$/.test(manifestHash) || sha(manifestText) !== manifestHash)
  throw new Error('Client manifest SHA-256 mismatch')
const manifest = JSON.parse(manifestText)
const expectedExecutable = 'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'
const dumpText = readFileSync(path.join(directory, 'native-registrations.json'), 'utf8')
const files = manifest.files.filter(
  (file: { path: string }) => file.path === 'native-registrations.json'
)
if (
  manifest.format !== 1 ||
  manifest.client.original_executable_sha256 !== expectedExecutable ||
  files.length !== 1 ||
  sha(dumpText) !== files[0].sha256
)
  throw new Error('Untrusted native extraction or SHA-256 mismatch')
const dump = JSON.parse(dumpText)
if (
  dump.format !== 1 ||
  dump.executable_sha256 !== expectedExecutable ||
  !Array.isArray(dump.registrations)
)
  throw new Error('Invalid native registration dump')
interface TableDecision {
  widget: string
  methods_sha256: string
  reason: string
  exact_inheritance?: boolean
}
let decisions: {
  overrides: Record<string, TableDecision>
  missing_widgets: Record<string, TableDecision>
} = {
  overrides: {},
  missing_widgets: {}
}
let decisionHash = ''
if (overridePath) {
  const decisionText = readFileSync(overridePath, 'utf8')
  decisionHash = sha(decisionText)
  decisions = JSON.parse(decisionText)
}
if (!decisions.overrides || !decisions.missing_widgets) throw new Error('Invalid widget decisions')
const { overrides, missing_widgets: missingWidgets } = decisions
const address = /^0x[0-9A-F]{8}$/
interface Registration {
  kind: string
  name: string
  va: string
  context: string
  table: string
  index: number
  call_sites: string[]
}
const rows: Registration[] = dump.registrations
for (const row of rows)
  if (
    !['global', 'method'].includes(row.kind) ||
    typeof row.name !== 'string' ||
    !row.name ||
    !address.test(row.va) ||
    !address.test(row.table) ||
    !['game', 'glue'].includes(row.context) ||
    !Number.isSafeInteger(row.index) ||
    row.index < 0 ||
    !Array.isArray(row.call_sites) ||
    !row.call_sites.length ||
    !row.call_sites.every((site) => address.test(site))
  )
    throw new Error('Invalid native registration row')
const db = new DatabaseSync(database)
db.exec('PRAGMA foreign_keys = ON; BEGIN')
try {
  const widgetRows = db
    .prepare('SELECT name, methods, inherits, inheritedMethods FROM lua_widget')
    .all()
  const widgets = new Map<string, string[]>()
  const parents = new Map<string, string[]>()
  const inherited = new Map<string, string[]>()
  for (const row of widgetRows) {
    const name = String(row.name)
    widgets.set(name, JSON.parse(String(row.methods)))
    parents.set(name, JSON.parse(String(row.inherits)))
    inherited.set(name, JSON.parse(String(row.inheritedMethods)))
  }
  const tables = new Map<string, Registration[]>()
  for (const row of rows) {
    if (row.kind !== 'method') continue
    if (!tables.has(row.table)) tables.set(row.table, [])
    tables.get(row.table)?.push(row)
  }
  const resolved = new Map<string, string>()
  for (const [table, entries] of tables) {
    const names = sorted(entries.map((entry) => entry.name))
    const candidates = [...widgets]
      .filter(([, methods]) => sorted(methods) === names)
      .map(([name]) => name)
    const override = overrides[table]
    const missing = missingWidgets[table]
    if (override && missing) throw new Error(`Conflicting widget decisions: ${table}`)
    if (missing) {
      if (
        widgets.has(missing.widget) ||
        typeof missing.widget !== 'string' ||
        !missing.widget ||
        typeof missing.methods_sha256 !== 'string' ||
        missing.methods_sha256 !== sha(names) ||
        typeof missing.reason !== 'string' ||
        !missing.reason.trim() ||
        candidates.length
      )
        throw new Error(`Invalid or stale missing widget decision: ${table}`)
      continue
    }
    if (override) {
      if (
        !widgets.has(override.widget) ||
        typeof override.methods_sha256 !== 'string' ||
        override.methods_sha256 !== sha(names) ||
        typeof override.reason !== 'string' ||
        !override.reason.trim()
      )
        throw new Error(`Invalid or stale widget override: ${table}`)
      if (override.exact_inheritance) {
        const own = widgets.get(override.widget) ?? []
        const inheritedNames = inherited.get(override.widget) ?? []
        const baseNames = (parents.get(override.widget) ?? []).flatMap(
          (name) => widgets.get(name) ?? []
        )
        const matches = [...widgets].filter(
          ([name, methods]) => sorted([...methods, ...(inherited.get(name) ?? [])]) === names
        )
        const remaining = entries
          .map((entry) => entry.name)
          .filter((name) => !inheritedNames.includes(name))
        if (
          matches.length !== 1 ||
          matches[0][0] !== override.widget ||
          sorted(baseNames) !== sorted(inheritedNames) ||
          sorted(remaining) !== sorted(own)
        )
          throw new Error(`Invalid inherited widget override: ${table}`)
      }
      resolved.set(table, override.widget)
    } else {
      if (candidates.length !== 1)
        throw new Error(
          `Unresolved widget table ${table}: ${candidates.join(', ') || 'no exact match'}`
        )
      resolved.set(table, candidates[0])
    }
  }
  for (const table of Object.keys(overrides))
    if (!tables.has(table)) throw new Error(`Unused widget override: ${table}`)
  for (const table of Object.keys(missingWidgets))
    if (!tables.has(table)) throw new Error(`Unused missing widget decision: ${table}`)
  db.exec(
    `CREATE TABLE lua_native_registration (kind TEXT NOT NULL, name TEXT NOT NULL, va TEXT NOT NULL, context TEXT NOT NULL, registration_table TEXT NOT NULL, registration_index INTEGER NOT NULL, call_sites TEXT NOT NULL, widget TEXT, record_id TEXT REFERENCES record(id)); CREATE INDEX lua_native_record ON lua_native_registration(record_id)`
  )
  const insert = db.prepare(
    "INSERT INTO lua_native_registration VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''))"
  )
  const exists = db.prepare('SELECT 1 FROM record WHERE id = ?')
  const offsets = db.prepare('SELECT path FROM offsets_entry WHERE va = ? ORDER BY path')
  function declaringWidget(widget: string, name: string): string | undefined {
    if (widgets.get(widget)?.includes(name)) return widget
    if (!inherited.get(widget)?.includes(name)) return undefined
    const seen = new Set<string>([widget])
    const pending = [...(parents.get(widget) ?? [])]
    const matches = new Set<string>()
    while (pending.length) {
      const parent = pending.pop()
      if (!parent || seen.has(parent)) continue
      seen.add(parent)
      if (widgets.get(parent)?.includes(name)) matches.add(parent)
      pending.push(...(parents.get(parent) ?? []))
    }
    if (matches.size === 1) return [...matches][0]
    return undefined
  }
  for (const row of rows) {
    let widget: string | undefined
    let id = ''
    if (row.kind === 'global') id = `fn:${row.name}`
    if (row.kind === 'method') {
      widget = resolved.get(row.table)
      let declaring: string | undefined
      if (widget && !overrides[row.table]?.exact_inheritance)
        declaring = declaringWidget(widget, row.name)
      else if (widget && widgets.get(widget)?.includes(row.name)) declaring = widget
      if (declaring) id = `method:${declaring}:${row.name}`
    }
    let record = ''
    if (exists.get(id)) record = id
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
    if (widget) note += ` widget ${widget}`
    if (record)
      for (const offset of offsets.all(row.va))
        addLink(db, record, 'implemented by', `offset:${String(offset.path)}`, note)
  }
  db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)').run(
    'native-registrations',
    expectedExecutable,
    sha(dumpText),
    'Client-derived; redistribution risk accepted, permission not established',
    'Fingerprint-verified client executable registration tables; enGB English stand-in'
  )
  const pins = JSON.parse(
    String(db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()?.value)
  )
  pins.native = sha(dumpText)
  pins.native_manifest = manifestHash
  if (decisionHash) pins.native_widget_decisions = decisionHash
  db.prepare("UPDATE meta SET value = ? WHERE key = 'input_pins'").run(JSON.stringify(pins))
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
} finally {
  db.close()
}
