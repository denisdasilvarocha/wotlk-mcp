import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { Database } from '../../src/database.ts'
import { commandParser, type Command } from './commands.ts'
import { digest, type InterfaceFile } from './manifest.ts'

function readInterfaceFile(
  directory: string,
  file: Readonly<InterfaceFile>
): { text: string; archive: string; sha256: string } {
  if (
    file.path.split('/').some((part) => part === '.' || part === '..') ||
    !/^[a-f0-9]{64}$/u.test(String(file.sha256)) ||
    typeof file.archive !== 'string'
  ) {
    throw new Error(`Invalid Interface manifest entry: ${file.path}`)
  }

  const fullPath = path.join(directory, ...file.path.split('/'))
  let current = directory

  for (const part of file.path.split('/')) {
    current = path.join(current, part)

    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symlink in Interface path: ${file.path}`)
    }
  }

  const content = readFileSync(fullPath)

  if (typeof file.sha256 !== 'string' || digest(content) !== file.sha256) {
    throw new Error(`Interface SHA-256 mismatch: ${file.path}`)
  }

  return {
    archive: file.archive,
    sha256: file.sha256,
    text: new TextDecoder('utf-8', { fatal: true }).decode(content)
  }
}

function insertLines(
  db: Database,
  file: Readonly<InterfaceFile>,
  text: string,
  commands: Readonly<Map<string, Command>>
): void {
  const insertLine = db.prepare('INSERT INTO ui_line VALUES (?, ?, ?)')
  const lineFts = db.prepare('INSERT INTO ui_line_fts VALUES (?, ?, ?)')
  const relativePath = file.path.slice('Interface/'.length)
  const lines = text.split(/\r\n|\n|\r/u)

  if (lines.at(-1) === '') {
    lines.pop()
  }

  const parse = commandParser(commands)

  for (const [index, textLine] of lines.entries()) {
    const line = index + 1

    insertLine.run(relativePath, line, textLine)
    lineFts.run(relativePath, line, textLine)

    if (/\.lua$/iu.test(file.path)) {
      parse(textLine, relativePath, line)
    }
  }
}

export function insertFiles(
  db: Database,
  directory: string,
  files: readonly Readonly<InterfaceFile>[],
  provenance: string,
  commands: Readonly<Map<string, Command>>
): void {
  const insertFile = db.prepare('INSERT INTO ui_file VALUES (?, ?, ?, ?, ?, ?)')
  const insertRecord = db.prepare(
    'INSERT INTO record (id, kind, name, source_table, source_row, search_text, hint) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const recordFts = db.prepare('INSERT INTO record_fts VALUES (?, ?, ?)')

  for (const file of files) {
    const { text, archive, sha256 } = readInterfaceFile(directory, file)
    const relativePath = file.path.slice('Interface/'.length)
    let fileProvenance = provenance

    if (
      file.path === 'Interface/FrameXML/Localization.lua' ||
      file.path === 'Interface/AddOns/Blizzard_Calendar/Localization.lua'
    ) {
      fileProvenance +=
        '; known locale difference: https://github.com/denisdasilvarocha/wotlk-mcp/issues/14'
    }

    const row = insertFile.run(relativePath, file.path, archive, sha256, 'enGB', fileProvenance)

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
    insertLines(db, file, text, commands)
  }
}
