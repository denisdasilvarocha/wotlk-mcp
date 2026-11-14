import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

type Row = Record<string, any>
const [database, root, manifestPath = 'data/codex-pins.json'] = process.argv
  .slice(2)
  .filter((arg) => arg !== '--')
if (!database || !root)
  throw new Error('Usage: node scripts/import-codex.ts <database> <codex-checkout> [pins.json]')
const manifest: { revision: string; files: Record<string, string> } = JSON.parse(
  readFileSync(manifestPath, 'utf8')
)
const names = [
  'api-functions',
  'events',
  'widgets',
  'cvars',
  'data-types',
  'combat-log-events',
  'secure-templates',
  'book-chapters'
]
const aggregate = createHash('sha256')
for (const name of names) {
  const file = `src/data/${name}.ts`
  const bytes = readFileSync(path.join(root, file))
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== manifest.files[file]) throw new Error(`Codex SHA-256 mismatch: ${file}`)
  aggregate.update(file).update('\0').update(bytes)
}
const modules = await Promise.all(
  names.map((name) => import(pathToFileURL(path.resolve(root, `src/data/${name}.ts`)).href))
)
const [api, events, widgets, cvars, types, combat, templates, chapters] = modules
const fields: Record<string, string[]> = {
  fn: [
    'name',
    'description',
    'signature',
    'parameters',
    'returns',
    'examples',
    'tags',
    'category',
    'subcategory',
    'protected',
    'hwEvent',
    'related',
    'patch',
    'documentationUrl',
    'memoryAddress',
    'bookPage',
    'bookChapter'
  ],
  event: [
    'name',
    'description',
    'parameters',
    'category',
    'related',
    'patch',
    'documentationUrl',
    'bookPage',
    'bookChapter'
  ],
  widget: [
    'name',
    'description',
    'inherits',
    'methods',
    'inheritedMethods',
    'scriptHandlers',
    'category',
    'bookPage',
    'bookChapter'
  ],
  method: [
    'name',
    'signature',
    'description',
    'parameters',
    'returns',
    'behavior',
    'caveats',
    'example',
    'declaringWidget'
  ],
  cvar: ['name', 'defaultValue', 'description', 'category'],
  type: ['name', 'description', 'values', 'related', 'bookPage', 'bookChapter'],
  cle: ['name', 'description', 'type', 'prefixes', 'arguments', 'bookPage', 'bookChapter'],
  template: ['name', 'description', 'attributes', 'examples']
}
const db = new DatabaseSync(database)
db.exec('BEGIN')
try {
  const record = db.prepare(
    'INSERT INTO record (id, kind, name, source_table, source_row, search_text, hint) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const fts = db.prepare('INSERT INTO record_fts VALUES (?, ?, ?)')
  const statements = new Map<string, ReturnType<typeof db.prepare>>()
  const nil = db.prepare('SELECT NULL AS value').get()?.value
  for (const [kind, columns] of Object.entries(fields)) {
    const definitions = columns.map((column) => {
      let type = 'TEXT'
      if (['bookPage', 'bookChapter', 'protected', 'hwEvent'].includes(column)) type = 'INTEGER'
      return `"${column}" ${type}`
    })
    db.exec(`CREATE TABLE lua_${kind} (${definitions.join(', ')})`)
    statements.set(
      kind,
      db.prepare(`INSERT INTO lua_${kind} VALUES (${columns.map(() => '?').join(', ')})`)
    )
  }
  function add(kind: string, row: Row, key = row.name, indexName = row.name): void {
    const unknown = Object.keys(row).filter((field) => !fields[kind].includes(field))
    if (unknown.length) throw new Error(`Unexpected Codex ${kind} fields: ${unknown.join(', ')}`)
    const pages: Record<string, number> = chapters.CHAPTER_PAGES
    const chapter = Object.entries(pages).findLast(([, page]) => page <= row.bookPage)?.[0]
    const data: Row = { ...row, bookChapter: chapter && Number(chapter) }
    const values = fields[kind].map((field) => {
      const value = data[field]
      if (value === undefined || value === nil) return nil
      if (typeof value === 'object') return JSON.stringify(value)
      if (typeof value === 'boolean') return Number(value)
      return value
    })
    const statement = statements.get(kind)
    if (!statement) throw new Error(`Unknown Codex kind: ${kind}`)
    const result = statement.run(...values)
    const id = `${kind}:${key}`
    const description = row.description ?? ''
    record.run(
      id,
      kind,
      indexName,
      `lua_${kind}`,
      result.lastInsertRowid,
      description,
      row.category ?? ''
    )
    fts.run(id, indexName, description)
  }
  for (const row of api.API_FUNCTIONS) add('fn', row)
  for (const row of events.EVENTS) add('event', row)
  function methodName(method: Row): string {
    const match = /(?:^|:)([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(method.name)
    if (!match) throw new Error(`Unrecognized Codex widget method: ${method.name}`)
    return match[1]
  }
  for (const widget of widgets.WIDGETS) {
    for (const method of widget.methods) {
      const name = methodName(method)
      add('method', { ...method, declaringWidget: widget.name }, `${widget.name}:${name}`, name)
    }
    add('widget', {
      ...widget,
      methods: widget.methods.map(methodName),
      inheritedMethods: widget.inheritedMethods.map(methodName)
    })
  }
  for (const row of cvars.CVARS) add('cvar', row)
  for (const row of types.DATA_TYPES) add('type', row)
  for (const row of combat.COMBAT_LOG_SUB_EVENTS) {
    const prefix = (row.prefixes ?? []).find((name: string) => row.name.startsWith(`${name}_`))
    const args = combat.COMBAT_LOG_PREFIXES.find((item: Row) => item.name === prefix)?.arguments
    if (prefix && !args) throw new Error(`Unknown combat-log prefix: ${prefix}`)
    add('cle', { ...row, arguments: [...(args ?? []), ...row.arguments] })
  }
  for (const row of templates.SECURE_TEMPLATES) add('template', row)
  const digest = aggregate.digest('hex')
  db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)').run(
    'codex',
    manifest.revision,
    digest,
    'Unlicensed; redistribution risk accepted, permission not established',
    'Shard-MW MilkyWay Codex: https://github.com/Shard-MW/milkyway-codex'
  )
  const pins = JSON.parse(
    String(db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()?.value)
  )
  pins.codex = manifest.revision
  db.prepare("UPDATE meta SET value = ? WHERE key = 'input_pins'").run(JSON.stringify(pins))
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
} finally {
  db.close()
}
