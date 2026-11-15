import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const eligible = /^Interface\/(?:FrameXML|GlueXML|AddOns\/Blizzard_[^/]+)\/.+\.(?:lua|xml|toc)$/i
const executable = 'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'

interface Command {
  aliases: (Evidence & { value: string })[]
  handlers: Evidence[]
  emote: boolean
}

interface Evidence {
  path: string
  line: number
  global?: string
  value?: string
  registry?: string
}

function insertInterface(db: DatabaseSync, directory: string, manifestHash: string): void {
  if (!/^[a-f0-9]{64}$/.test(manifestHash))
    throw new Error('Expected lowercase SHA-256 of the trusted manifest')

  const bytes = readFileSync(path.join(directory, 'manifest.json'))

  if (digest(bytes) !== manifestHash) throw new Error('Client manifest SHA-256 mismatch')

  const manifest: {
    format: number
    client: { build: number; locale: string; original_executable_sha256: string }
    files: { path: string; archive: string; sha256: string }[]
  } = JSON.parse(bytes.toString('utf8'))

  if (
    manifest.format !== 1 ||
    manifest.client?.build !== 12340 ||
    manifest.client.locale !== 'enGB' ||
    manifest.client.original_executable_sha256 !== executable ||
    !Array.isArray(manifest.files)
  )
    throw new Error('Unsupported client manifest or fingerprint')

  const files = manifest.files
    .filter((file) => eligible.test(file.path))
    .toSorted((a, b) => a.path.localeCompare(b.path, 'en'))

  if (!files.length || new Set(files.map((file) => file.path.toLowerCase())).size !== files.length)
    throw new Error('Empty or duplicate Interface inventory')

  db.exec(`CREATE TABLE ui_file (path TEXT NOT NULL UNIQUE, manifest_path TEXT NOT NULL, archive TEXT NOT NULL, sha256 TEXT NOT NULL, locale TEXT NOT NULL, provenance TEXT NOT NULL);
    CREATE TABLE ui_line (path TEXT NOT NULL REFERENCES ui_file(path), line INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(path, line));
    CREATE TABLE ui_slash (command TEXT NOT NULL UNIQUE, aliases TEXT NOT NULL, secure INTEGER, handlers TEXT NOT NULL, emote INTEGER NOT NULL, locale TEXT NOT NULL, provenance TEXT NOT NULL);`)

  const insertFile = db.prepare('INSERT INTO ui_file VALUES (?, ?, ?, ?, ?, ?)')
  const insertLine = db.prepare('INSERT INTO ui_line VALUES (?, ?, ?)')
  const lineFts = db.prepare('INSERT INTO ui_line_fts VALUES (?, ?, ?)')
  const insertRecord = db.prepare(
    'INSERT INTO record (id, kind, name, source_table, source_row, search_text, hint) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const provenance =
    'enGB English stand-in; enUS byte identity is not verified; locale-only differences may exist'
  const recordFts = db.prepare('INSERT INTO record_fts VALUES (?, ?, ?)')
  const commands = new Map<string, Command>()

  function command(key: string, emote = false): Command {
    let value = commands.get(key)

    if (!value) {
      value = { aliases: [], handlers: [], emote }
      commands.set(key, value)
    }

    return value
  }

  for (const file of files) {
    if (
      file.path.split('/').some((part) => part === '.' || part === '..') ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.archive !== 'string'
    )
      throw new Error(`Invalid Interface manifest entry: ${file.path}`)

    const fullPath = path.join(directory, ...file.path.split('/'))
    let current = directory

    for (const part of file.path.split('/')) {
      current = path.join(current, part)

      if (lstatSync(current).isSymbolicLink())
        throw new Error(`Symlink in Interface path: ${file.path}`)
    }

    const content = readFileSync(fullPath)

    if (digest(content) !== file.sha256) throw new Error(`Interface SHA-256 mismatch: ${file.path}`)

    let fileProvenance = provenance
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
    const relativePath = file.path.slice('Interface/'.length)

    if (
      file.path === 'Interface/FrameXML/Localization.lua' ||
      file.path === 'Interface/AddOns/Blizzard_Calendar/Localization.lua'
    )
      fileProvenance +=
        '; known locale difference: https://github.com/denisdasilvarocha/wotlk-mcp/issues/14'

    const row = insertFile.run(
      relativePath,
      file.path,
      file.archive,
      file.sha256,
      'enGB',
      fileProvenance
    )

    insertRecord.run(
      `file:${relativePath}`,
      'file',
      relativePath,
      'ui_file',
      row.lastInsertRowid,
      '',
      ''
    )
    recordFts.run(`file:${relativePath}`, relativePath, '')

    const lines = text.split(/\r\n|\n|\r/)

    if (lines.at(-1) === '') lines.pop()

    let blockComment = false

    for (const [index, textLine] of lines.entries()) {
      const line = index + 1

      insertLine.run(relativePath, line, textLine)
      lineFts.run(relativePath, line, textLine)

      if (!/\.lua$/i.test(file.path)) continue

      let code = textLine

      if (blockComment) {
        const end = code.indexOf(']]')

        if (end < 0) continue

        code = code.slice(end + 2)
        blockComment = false
      }

      const block = code.indexOf('--[[')

      if (block >= 0) {
        const end = code.indexOf(']]', block + 4)

        if (end < 0) {
          code = code.slice(0, block)
          blockComment = true
        } else code = code.slice(0, block) + code.slice(end + 2)
      }

      if (/^\s*--/.test(code)) continue

      const alias = code.match(
        /^\s*(SLASH_([A-Z][A-Z0-9_]*?)(\d+)|EMOTE(\d+)_CMD\d*)\s*=\s*(["'])(\/[^"']+)\5/
      )

      if (alias) {
        const key = alias[2] ?? `EMOTE${alias[4]}`

        command(key, !!alias[4]).aliases.push({
          path: relativePath,
          line,
          global: alias[1],
          value: alias[6]
        })
      }

      const handler = code.match(
        /^\s*(SecureCmdList|SlashCmdList)\s*\[\s*["']([^"']+)["']\s*\]\s*=/
      )

      if (handler)
        command(handler[2]).handlers.push({ path: relativePath, line, registry: handler[1] })
    }
  }

  const insertSlash = db.prepare('INSERT INTO ui_slash VALUES (?, ?, NULLIF(?, -1), ?, ?, ?, ?)')

  for (const [key, value] of [...commands].toSorted(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (!value.aliases.length) continue

    const aliases = [...new Set(value.aliases.map((item) => item.value))]
    const [name] = aliases
    let secure = -1

    if (value.handlers.length) secure = 0

    if (value.handlers.some((item) => item.registry === 'SecureCmdList')) secure = 1

    let hint = ''

    if (value.emote) hint = 'emote'

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

    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate())
      hash.update(JSON.stringify(Object.values(row))).update('\n')

    db.prepare('INSERT INTO meta VALUES (?, ?)').run(`hash.${table}`, hash.digest('hex'))
  }
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function importInterface(database: string, directory: string, manifestHash: string): void {
  if (!existsSync(database)) throw new Error(`Database does not exist: ${database}`)

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
