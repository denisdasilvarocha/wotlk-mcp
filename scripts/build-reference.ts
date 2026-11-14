import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadOffsets } from '../src/offsets.ts'
import { schema } from '../src/schema.ts'

const output = process.argv[2]
if (!output) throw new Error('Usage: vp run build:reference -- <new-database-path>')
const directory = 'data/offsets'
const entries = loadOffsets(directory)
const hash = createHash('sha256')
for (const file of readdirSync(directory).filter((name) => name.endsWith('.json')).toSorted()) {
  hash.update(file).update('\0').update(readFileSync(path.join(directory, file)))
}
const digest = hash.digest('hex')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const db = new DatabaseSync(output)
db.exec('BEGIN')
try {
  db.exec(schema)
  const metadata = db.prepare('INSERT INTO meta VALUES (?, ?)')
  for (const [key, value] of Object.entries({ schema_version: '1.0.0', build_time: new Date().toISOString(), build_commit: commit, input_pins: JSON.stringify({ offsets: commit }), 'hash.offsets_entry': createHash('sha256').update(JSON.stringify(entries.toSorted((a, b) => a.path.localeCompare(b.path)))).digest('hex') })) metadata.run(key, value)
  db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)').run('offsets', commit, digest, 'Project curated data; see repository', 'wotlk-mcp contributors')
  const source = db.prepare('INSERT INTO offsets_entry VALUES (?, ?, ?, ?, ?)')
  const record = db.prepare('INSERT INTO record (id, kind, name, source_table, source_row, search_text) VALUES (?, ?, ?, ?, ?, ?)')
  const fts = db.prepare('INSERT INTO record_fts VALUES (?, ?, ?)')
  for (const entry of entries) {
    const result = source.run(entry.path, entry.va, entry.kind, entry.note, entry.status ?? null)
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
