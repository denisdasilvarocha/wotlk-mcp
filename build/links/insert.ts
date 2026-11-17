import type { Database } from '../../src/database.ts'
import { relations } from '../../src/schema.ts'

export type AddLink = (
  sourceId: string,
  relation: string,
  destinationId: string,
  note?: string
) => void

const forwardRelations = new Set(relations.map((pair: readonly string[]) => pair[0]))

// Prepares the Link statements once; each call adds evidence for a directed Link. Callers retain the original source rows separately.
export function linkWriter(db: Database): AddLink {
  const select = db.prepare(
    'SELECT notes FROM link WHERE source_id = ? AND relation = ? AND destination_id = ?'
  )
  const upsert =
    db.prepare(`INSERT INTO link (source_id, relation, destination_id, notes) VALUES (?, ?, ?, ?)
    ON CONFLICT(source_id, relation, destination_id) DO UPDATE SET notes = excluded.notes`)

  return (sourceId, relation, destinationId, note = '') => {
    if (!forwardRelations.has(relation)) {
      throw new Error(`invalid forward relation: ${relation}`)
    }

    const existing = select.get(sourceId, relation, destinationId)?.notes
    let notes: unknown[] = []

    if (typeof existing === 'string' && existing !== '') {
      const parsed: unknown = JSON.parse(existing)
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
    upsert.run(sourceId, relation, destinationId, JSON.stringify(notes))
  }
}

export function addLinkRows(db: Database, query: string, relation: string): void {
  const addLink = linkWriter(db)

  for (const row of db.prepare(query).iterate()) {
    addLink(String(row.source), relation, String(row.destination), String(row.note))
  }
}
