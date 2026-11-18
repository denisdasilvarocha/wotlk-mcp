import { schema } from '../src/schema.ts'
import { indexRecords } from './shared/search-index.ts'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as z from 'zod'

import type { Database } from '../src/database.ts'

const offsetDirectory = 'data/offsets'

export const offsetTopicSchema = z.array(
  z.strictObject({
    kind: z.enum(['function', 'data']),
    note: z.string(),
    path: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)+$/u),
    status: z.enum(['not-present', 'unverified']).optional(),
    va: z.string().regex(/^0x[0-9A-F]{8}$/u)
  })
)

export type OffsetEntry = z.infer<typeof offsetTopicSchema>[number]

export function loadCommittedOffsets(commit: string): { entries: OffsetEntry[]; digest: string } {
  const tree = `${commit}:${offsetDirectory}`
  const files = execFileSync(
    'git',
    ['--no-replace-objects', 'ls-tree', '--full-tree', '--name-only', '-z', tree],
    { encoding: 'utf8' }
  ).split('\0')
  const hash = createHash('sha256')

  const entries = parseOffsets(offsetDirectory, files, (file) => {
    const bytes = execFileSync('git', [
      '--no-replace-objects',
      'cat-file',
      'blob',
      `${tree}/${file}`
    ])
    hash.update(file).update('\0').update(bytes)
    return bytes.toString('utf8')
  })

  return { entries, digest: hash.digest('hex') }
}

function insertOffsets(db: Database, entries: readonly Readonly<OffsetEntry>[]): void {
  const source = db.prepare("INSERT INTO offsets_entry VALUES (?, ?, ?, ?, NULLIF(?, ''))")
  const record = db.prepare(
    'INSERT INTO record (id, kind, name, source_table, source_row, search_text) VALUES (?, ?, ?, ?, ?, ?)'
  )

  for (const entry of entries) {
    const result = source.run(entry.path, entry.va, entry.kind, entry.note, entry.status ?? '')
    record.run(
      `offset:${entry.path}`,
      'offset',
      entry.path,
      'offsets_entry',
      result.lastInsertRowid,
      entry.note
    )
  }
}

export function initReference(output: string): void {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const { entries, digest } = loadCommittedOffsets(commit)
  const db = new DatabaseSync(output)

  db.exec('BEGIN')

  try {
    db.exec(schema)

    const metadata = db.prepare('INSERT INTO meta VALUES (?, ?)')

    for (const [key, value] of Object.entries({
      build_commit: commit,
      build_time: new Date().toISOString(),
      'hash.offsets_entry': createHash('sha256')
        .update(JSON.stringify(entries.toSorted((a, b) => a.path.localeCompare(b.path))))
        .digest('hex'),
      input_pins: JSON.stringify({ offsets: commit }),
      schema_version: '1.0.0'
    })) {
      metadata.run(key, value)
    }

    db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)').run(
      'offsets',
      commit,
      digest,
      'Project curated data; see repository',
      'wotlk-mcp contributors'
    )

    insertOffsets(db, entries)
    indexRecords(db)

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

export function loadOffsets(directory: string): OffsetEntry[] {
  return parseOffsets(directory, readdirSync(directory), (file) =>
    readFileSync(path.join(directory, file), 'utf8')
  )
}

function parseOffsets(
  directory: string,
  files: readonly string[],
  readTopic: (file: string) => string
): OffsetEntry[] {
  const topics = files.filter((file) => file.endsWith('.json')).toSorted()

  if (topics.length === 0) {
    throw new Error(`No topic JSON documents in ${directory}`)
  }

  const offsets: OffsetEntry[] = []
  const paths = new Set<string>()

  for (const file of topics) {
    const entries = offsetTopicSchema.parse(JSON.parse(readTopic(file)))

    for (const offset of entries) {
      if (paths.has(offset.path)) {
        throw new Error(`Duplicate Offset path: ${offset.path}`)
      }

      paths.add(offset.path)
      offsets.push(offset)
    }
  }

  return offsets
}
