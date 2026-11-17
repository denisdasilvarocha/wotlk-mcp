import type { Database } from '../../src/database.ts'
import { relations } from '../../src/schema.ts'

// Add evidence for a directed Link; callers retain the original source rows separately.
export function addLink(
  db: Database,
  sourceId: string,
  relation: string,
  destinationId: string,
  note = ''
): void {
  if (!relations.some((pair: readonly string[]) => pair[0] === relation)) {
    throw new Error(`invalid forward relation: ${relation}`)
  }

  const existing = db
    .prepare('SELECT notes FROM link WHERE source_id = ? AND relation = ? AND destination_id = ?')
    .get(sourceId, relation, destinationId)
  let notes: unknown[] = []

  const hasNotes = Boolean(existing?.notes)
  if (hasNotes) {
    const parsed: unknown = JSON.parse(String(existing?.notes))
    if (!Array.isArray(parsed)) {
      throw new TypeError('Invalid link notes')
    }
    notes = parsed
  }

  if (note && !notes.includes(note)) {
    notes.push(note)
  }
  notes.sort((a, b) => {
    const left = String(a)
    const right = String(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
  db.prepare(`INSERT INTO link (source_id, relation, destination_id, notes) VALUES (?, ?, ?, ?)
    ON CONFLICT(source_id, relation, destination_id) DO UPDATE SET notes = excluded.notes`).run(
    sourceId,
    relation,
    destinationId,
    JSON.stringify(notes)
  )
}

export function addLinkRows(db: Database, query: string, relation: string): void {
  for (const row of db.prepare(query).iterate()) {
    addLink(db, String(row.source), relation, String(row.destination), String(row.note))
  }
}
