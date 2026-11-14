import type { DatabaseSync } from 'node:sqlite'

import { relations } from '../src/schema.ts'

/** Add evidence for a directed Link; callers retain the original source rows separately. */
export function addLink(
  db: DatabaseSync,
  sourceId: string,
  relation: string,
  destinationId: string,
  note = ''
): void {
  if (!relations.some(([forward]) => forward === relation))
    throw new Error(`invalid forward relation: ${relation}`)
  const existing = db
    .prepare('SELECT notes FROM link WHERE source_id = ? AND relation = ? AND destination_id = ?')
    .get(sourceId, relation, destinationId)
  let notes: string[] = []
  if (existing?.notes) notes = JSON.parse(String(existing.notes))
  if (note && !notes.includes(note)) notes.push(note)
  notes.sort()
  db.prepare(`INSERT INTO link (source_id, relation, destination_id, notes) VALUES (?, ?, ?, ?)
    ON CONFLICT(source_id, relation, destination_id) DO UPDATE SET notes = excluded.notes`).run(
    sourceId,
    relation,
    destinationId,
    JSON.stringify(notes)
  )
}
