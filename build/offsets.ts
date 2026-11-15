import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as z from 'zod'

import { schema } from '../src/schema.ts'

export const offsetTopicSchema = z.array(
  z.strictObject({
    path: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)+$/),
    va: z.string().regex(/^0x[0-9A-F]{8}$/),
    kind: z.enum(['function', 'data']),
    note: z.string(),
    status: z.enum(['not-present', 'unverified']).optional()
  })
)

export type OffsetEntry = z.infer<typeof offsetTopicSchema>[number]

export function initReference(output: string): void {
  const directory = 'data/offsets'
  const entries = loadOffsets(directory)
  const hash = createHash('sha256')

  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .toSorted())
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(path.join(directory, file)))

  const digest = hash.digest('hex')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const db = new DatabaseSync(output)

  db.exec('BEGIN')

  try {
    db.exec(schema)

    const metadata = db.prepare('INSERT INTO meta VALUES (?, ?)')

    for (const [key, value] of Object.entries({
      schema_version: '1.0.0',
      build_time: new Date().toISOString(),
      build_commit: commit,
      input_pins: JSON.stringify({ offsets: commit }),
      'hash.offsets_entry': createHash('sha256')
        .update(JSON.stringify(entries.toSorted((a, b) => a.path.localeCompare(b.path))))
        .digest('hex')
    }))
      metadata.run(key, value)

    db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)').run(
      'offsets',
      commit,
      digest,
      'Project curated data; see repository',
      'wotlk-mcp contributors'
    )

    const source = db.prepare("INSERT INTO offsets_entry VALUES (?, ?, ?, ?, NULLIF(?, ''))")
    const record = db.prepare(
      'INSERT INTO record (id, kind, name, source_table, source_row, search_text) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const fts = db.prepare('INSERT INTO record_fts VALUES (?, ?, ?)')

    for (const entry of entries) {
      const result = source.run(entry.path, entry.va, entry.kind, entry.note, entry.status ?? '')
      const id = `offset:${entry.path}`

      record.run(id, 'offset', entry.path, 'offsets_entry', result.lastInsertRowid, entry.note)
      fts.run(id, entry.path, entry.note)
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

export function loadOffsets(directory: string): OffsetEntry[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .toSorted()

  if (files.length === 0) throw new Error(`No topic JSON documents in ${directory}`)

  const offsets: OffsetEntry[] = []
  const paths = new Set<string>()

  for (const file of files) {
    const entries = offsetTopicSchema.parse(
      JSON.parse(readFileSync(path.join(directory, file), 'utf8'))
    )

    for (const offset of entries) {
      if (paths.has(offset.path)) throw new Error(`Duplicate Offset path: ${offset.path}`)

      paths.add(offset.path)
      offsets.push(offset)
    }
  }

  return offsets
}
