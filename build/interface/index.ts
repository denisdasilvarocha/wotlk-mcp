import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import type { Database } from '../../src/database.ts'
import type { Command, Evidence } from './commands.ts'
import { insertFiles } from './files.ts'
import { interfaceFiles } from './manifest.ts'

const provenance =
  'enGB English stand-in; enUS byte identity is not verified; locale-only differences may exist'

function insertSlashCommands(db: Database, commands: Readonly<Map<string, Command>>): void {
  const insertRecord = db.prepare(
    'INSERT INTO record (id, kind, name, source_table, source_row, search_text, hint) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const recordFts = db.prepare('INSERT INTO record_fts VALUES (?, ?, ?)')
  const insertSlash = db.prepare('INSERT INTO ui_slash VALUES (?, ?, NULLIF(?, -1), ?, ?, ?, ?)')

  for (const [key, value] of [...commands].toSorted(
    ([a]: readonly [string, unknown], [b]: readonly [string, unknown]) => a.localeCompare(b, 'en')
  )) {
    if (value.aliases.length === 0) {
      continue
    }

    const aliases = [
      ...new Set(value.aliases.map((item: Readonly<Evidence & { value: string }>) => item.value))
    ]
    const [name] = aliases
    let secure = -1

    if (value.handlers.length > 0) {
      secure = 0
    }

    if (value.handlers.some((item: Readonly<Evidence>) => item.registry === 'SecureCmdList')) {
      secure = 1
    }

    let hint = ''

    if (value.emote) {
      hint = 'emote'
    }

    const row = insertSlash.run(
      key,
      JSON.stringify(value.aliases),
      secure,
      JSON.stringify(value.handlers),
      Number(value.emote),
      'enGB',
      provenance
    )
    const id = `slash:${key}`
    const search = aliases.join(' ')

    insertRecord.run(id, 'slash', name, 'ui_slash', row.lastInsertRowid, search, hint)
    recordFts.run(id, name, search)
  }
}

function insertInterface(db: Database, directory: string, manifestHash: string): void {
  const files = interfaceFiles(directory, manifestHash)

  db.exec(`CREATE TABLE ui_file (path TEXT NOT NULL UNIQUE, manifest_path TEXT NOT NULL, archive TEXT NOT NULL, sha256 TEXT NOT NULL, locale TEXT NOT NULL, provenance TEXT NOT NULL);
    CREATE TABLE ui_line (path TEXT NOT NULL REFERENCES ui_file(path), line INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(path, line));
    CREATE TABLE ui_slash (command TEXT NOT NULL UNIQUE, aliases TEXT NOT NULL, secure INTEGER, handlers TEXT NOT NULL, emote INTEGER NOT NULL, locale TEXT NOT NULL, provenance TEXT NOT NULL);`)

  const commands = new Map<string, Command>()

  insertFiles(db, directory, files, provenance, commands)
  insertSlashCommands(db, commands)
  db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)').run(
    'interface',
    'build 12340 enGB',
    manifestHash,
    'Blizzard-derived client data; redistribution accepted by project owner',
    provenance
  )
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('hash.interface_manifest', manifestHash)

  for (const [table, order] of [
    ['ui_file', 'path'],
    ['ui_line', 'path, line'],
    ['ui_slash', 'command']
  ] as const) {
    const hash = createHash('sha256')

    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
      hash.update(JSON.stringify(Object.values(row))).update('\n')
    }

    db.prepare('INSERT INTO meta VALUES (?, ?)').run(`hash.${table}`, hash.digest('hex'))
  }
}

export function importInterface(database: string, directory: string, manifestHash: string): void {
  if (!existsSync(database)) {
    throw new Error(`Database does not exist: ${database}`)
  }

  const db = new DatabaseSync(database, { open: false })

  db.open()
  db.exec('BEGIN')

  try {
    insertInterface(db, directory, manifestHash)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
