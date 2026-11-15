import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

import type { CodexSource } from './sources.ts'

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

type Row = Record<string, any>

export interface CodexData {
  API_FUNCTIONS: Row[]
  EVENTS: Row[]
  WIDGETS: Row[]
  CVARS: Row[]
  DATA_TYPES: Row[]
  COMBAT_LOG_SUB_EVENTS: Row[]
  COMBAT_LOG_PREFIXES: Row[]
  SECURE_TEMPLATES: Row[]
  CHAPTER_PAGES: Record<string, number>
}

export async function readCodex(source: CodexSource, nodeImage: string): Promise<CodexData> {
  const aggregate = createHash('sha256')

  for (const name of names) {
    const file = `src/data/${name}.ts`
    const bytes = readFileSync(path.join(source.directory, file))
    const digest = createHash('sha256').update(bytes).digest('hex')

    if (digest !== source.files[file]) throw new Error(`Codex SHA-256 mismatch: ${file}`)

    aggregate.update(file).update('\0').update(bytes)
  }

  if (aggregate.digest('hex') !== source.sha256) throw new Error('Codex aggregate SHA-256 mismatch')

  const container = `wotlk-codex-${randomBytes(12).toString('hex')}`
  const controller = new AbortController()

  function onInterrupt(): void {
    process.exitCode = 130
    controller.abort()
  }

  function onTerminate(): void {
    process.exitCode = 143
    controller.abort()
  }

  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)

  let failed = false
  let failure: unknown
  let result: CodexData | undefined
  const run = promisify(execFile)

  try {
    const script = `
const [api, events, widgets, cvars, types, combat, templates, chapters] =
  await Promise.all(${JSON.stringify(names)}.map(name => import('/input/src/data/' + name + '.ts')));
console.log(JSON.stringify({
  API_FUNCTIONS: api.API_FUNCTIONS, EVENTS: events.EVENTS, WIDGETS: widgets.WIDGETS,
  CVARS: cvars.CVARS, DATA_TYPES: types.DATA_TYPES,
  COMBAT_LOG_SUB_EVENTS: combat.COMBAT_LOG_SUB_EVENTS, COMBAT_LOG_PREFIXES: combat.COMBAT_LOG_PREFIXES,
  SECURE_TEMPLATES: templates.SECURE_TEMPLATES, CHAPTER_PAGES: chapters.CHAPTER_PAGES
}));`
    const mount = `type=bind,"src=${path.resolve(source.directory).replaceAll('"', '""')}",dst=/input,readonly`
    const evaluation = run(
      'docker',
      [
        'run',
        '--name',
        container,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        'node',
        '--mount',
        mount,
        nodeImage,
        'node',
        '--input-type=module',
        '-e',
        script
      ],
      {
        signal: controller.signal,
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        killSignal: 'SIGKILL'
      }
    )

    function killEvaluation(): void {
      evaluation.child.kill('SIGKILL')
    }

    controller.signal.addEventListener('abort', killEvaluation)

    try {
      if (controller.signal.aborted) killEvaluation()

      const { stdout } = await evaluation

      result = JSON.parse(stdout)
    } finally {
      controller.signal.removeEventListener('abort', killEvaluation)
    }
  } catch (error) {
    failed = true
    failure = error
  } finally {
    try {
      await run('docker', ['rm', '-fv', container], { timeout: 60_000, killSignal: 'SIGKILL' })
    } catch (error) {
      if (!failed) {
        failed = true
        failure = error
      }
    } finally {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
    }
  }

  if (failed) throw failure
  if (controller.signal.aborted) throw new Error('Codex evaluation interrupted')
  if (!result) throw new Error('Codex evaluation returned no data')

  return result
}

export function importCodex(database: string, source: CodexSource, data: CodexData): void {
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

      const pages = data.CHAPTER_PAGES
      const chapter = Object.entries(pages).findLast(([, page]) => page <= row.bookPage)?.[0]
      const valuesByField: Row = { ...row, bookChapter: chapter && Number(chapter) }
      const values = fields[kind].map((field) => {
        const value = valuesByField[field]

        if (value === undefined || value === nil) return nil
        if (typeof value === 'object') return JSON.stringify(value)
        if (typeof value === 'boolean') return Number(value)

        return value
      })
      const statement = statements.get(kind)

      if (!statement) throw new Error(`Unknown Codex kind: ${kind}`)

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

    for (const row of data.API_FUNCTIONS) add('fn', row)

    for (const row of data.EVENTS) add('event', row)

    function methodName(method: Row): string {
      const match = /(?:^|:)([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(method.name)

      if (!match) throw new Error(`Unrecognized Codex widget method: ${method.name}`)

      return match[1]
    }

    for (const widget of data.WIDGETS) {
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

    for (const row of data.CVARS) add('cvar', row)

    for (const row of data.DATA_TYPES) add('type', row)

    for (const row of data.COMBAT_LOG_SUB_EVENTS) {
      const prefix = (row.prefixes ?? []).find((name: string) => row.name.startsWith(`${name}_`))
      const args = data.COMBAT_LOG_PREFIXES.find((item: Row) => item.name === prefix)?.arguments

      if (prefix && !args) throw new Error(`Unknown combat-log prefix: ${prefix}`)

      add('cle', { ...row, arguments: [...(args ?? []), ...row.arguments] })
    }

    for (const row of data.SECURE_TEMPLATES) add('template', row)
    db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)').run(
      'codex',
      source.revision,
      source.sha256,
      'Unlicensed; redistribution risk accepted, permission not established',
      'Shard-MW MilkyWay Codex: https://github.com/Shard-MW/milkyway-codex'
    )

    const pins = JSON.parse(
      String(db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()?.value)
    )

    pins.codex = source.revision
    db.prepare("UPDATE meta SET value = ? WHERE key = 'input_pins'").run(JSON.stringify(pins))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
