import type { Database } from '../src/database.ts'
import type { CodexRow, ReadonlyCodexData, ReadonlyCodexSource } from './codex.ts'

const fields: Record<string, string[]> = {
  cle: ['name', 'description', 'type', 'prefixes', 'arguments', 'bookPage', 'bookChapter'],
  cvar: ['name', 'defaultValue', 'description', 'category'],
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
  template: ['name', 'description', 'attributes', 'examples'],
  type: ['name', 'description', 'values', 'related', 'bookPage', 'bookChapter'],
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
  ]
}

function methodName(method: Readonly<CodexRow>): string {
  const match = /(?:^|:)([A-Za-z_][A-Za-z0-9_]*)\s*\(/u.exec(method.name)
  if (!match) {
    throw new Error(`Unrecognized Codex widget method: ${method.name}`)
  }
  return match[1]
}

function createTables(db: Database): Map<string, ReturnType<Database['prepare']>> {
  const statements = new Map<string, ReturnType<Database['prepare']>>()
  for (const [kind, columns] of Object.entries(fields)) {
    const definitions = columns.map((column) => {
      let type = 'TEXT'
      if (['bookPage', 'bookChapter', 'protected', 'hwEvent'].includes(column)) {
        type = 'INTEGER'
      }
      return `"${column}" ${type}`
    })
    db.exec(`CREATE TABLE lua_${kind} (${definitions.join(', ')})`)
    statements.set(
      kind,
      db.prepare(`INSERT INTO lua_${kind} VALUES (${columns.map(() => '?').join(', ')})`)
    )
  }
  return statements
}

function rowValues(
  kind: string,
  row: Readonly<CodexRow>,
  data: ReadonlyCodexData
): (string | number | null)[] {
  const unknown = Object.keys(row).filter((field) => !fields[kind].includes(field))
  if (unknown.length > 0) {
    throw new Error(`Unexpected Codex ${kind} fields: ${unknown.join(', ')}`)
  }
  const chapter = Object.entries(data.CHAPTER_PAGES).findLast(
    ([, page]: readonly [string, number]) => page <= Number(row.bookPage)
  )?.[0]
  const valuesByField: Readonly<CodexRow> = {
    ...row,
    bookChapter: chapter === undefined || chapter === '' ? chapter : Number(chapter)
  }
  return fields[kind].map((field) => {
    const value = valuesByField[field]
    if (value === undefined || value === null) {
      return null
    }
    if (typeof value === 'object') {
      return JSON.stringify(value)
    }
    if (typeof value === 'boolean') {
      return Number(value)
    }
    return value
  })
}

function createAdder(
  db: Database,
  data: ReadonlyCodexData
): (kind: string, row: Readonly<CodexRow>, key?: string, indexName?: string) => void {
  const record = db.prepare(
    'INSERT INTO record (id, kind, name, source_table, source_row, search_text, hint) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const fts = db.prepare('INSERT INTO record_fts VALUES (?, ?, ?)')
  const statements = createTables(db)
  db.prepare('SELECT NULL AS value').get()

  return function add(
    kind: string,
    row: Readonly<CodexRow>,
    key = row.name,
    indexName = row.name
  ): void {
    const values = rowValues(kind, row, data)
    const statement = statements.get(kind)
    if (!statement) {
      throw new Error(`Unknown Codex kind: ${kind}`)
    }
    const description = row.description ?? ''
    const id = `${kind}:${key}`
    const result = statement.run(...values)
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
}

function importWidgets(data: ReadonlyCodexData, add: ReturnType<typeof createAdder>): void {
  for (const widget of data.WIDGETS) {
    for (const method of widget.methods) {
      const name = methodName(method)
      add('method', { ...method, declaringWidget: widget.name }, `${widget.name}:${name}`, name)
    }
    add('widget', {
      ...widget,
      inheritedMethods: widget.inheritedMethods.map(methodName),
      methods: widget.methods.map(methodName)
    })
  }
}

export function importCodexRows(
  db: Database,
  source: ReadonlyCodexSource,
  data: ReadonlyCodexData
): void {
  const add = createAdder(db, data)
  for (const row of data.API_FUNCTIONS) {
    add('fn', row)
  }
  for (const row of data.EVENTS) {
    add('event', row)
  }
  importWidgets(data, add)
  for (const row of data.CVARS) {
    add('cvar', row)
  }
  for (const row of data.DATA_TYPES) {
    add('type', row)
  }
  for (const row of data.COMBAT_LOG_SUB_EVENTS) {
    const prefix = (row.prefixes ?? []).find((name) => row.name.startsWith(`${name}_`))
    const args = data.COMBAT_LOG_PREFIXES.find((item) => item.name === prefix)?.arguments
    if (prefix !== undefined && prefix !== '' && !args) {
      throw new Error(`Unknown combat-log prefix: ${prefix}`)
    }
    add('cle', { ...row, arguments: [...(args ?? []), ...row.arguments] })
  }
  for (const row of data.SECURE_TEMPLATES) {
    add('template', row)
  }
  db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)').run(
    'codex',
    source.revision,
    source.sha256,
    'Unlicensed; redistribution risk accepted, permission not established',
    'Shard-MW MilkyWay Codex: https://github.com/Shard-MW/milkyway-codex'
  )
  const parsePins: (text: string) => Record<string, unknown> = JSON.parse
  const pins = parsePins(
    String(db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()?.value)
  )
  pins.codex = source.revision
  db.prepare("UPDATE meta SET value = ? WHERE key = 'input_pins'").run(JSON.stringify(pins))
}
