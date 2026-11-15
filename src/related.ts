import type { DatabaseSync } from 'node:sqlite'

import { relations } from './schema.js'

interface RelatedInput {
  id: string
  rel?: string
  limit: number
  offset: number
}

export function getRelated(db: DatabaseSync, args: RelatedInput): string {
  let end = 0
  const filter = "WHERE (? = '' OR displayed = ?)"
  const inverse = relations
    .map(([forward, reverse]) => `WHEN '${forward}' THEN '${reverse}'`)
    .join(' ')
  const neighborhood = `SELECT relation AS displayed, destination_id AS destination, notes FROM link WHERE source_id = ?
    UNION ALL
    SELECT CASE relation ${inverse} END AS displayed, source_id AS destination, notes FROM link WHERE destination_id = ?`
  const params = [args.id, args.id, args.rel ?? '', args.rel ?? ''] as const
  let start = 0
  const total = Number(
    db.prepare(`SELECT count(*) AS total FROM (${neighborhood}) ${filter}`).get(...params)?.total
  )
  const rows = db
    .prepare(`SELECT displayed, destination, notes FROM (${neighborhood}) ${filter}
    ORDER BY displayed COLLATE BINARY, destination COLLATE BINARY LIMIT ? OFFSET ?`)
    .all(...params, args.limit, args.offset)
  const lines = rows.map((row) => {
    let notes: string[] = []

    if (row.notes) notes = JSON.parse(String(row.notes))

    let suffix = ''

    if (notes.length) suffix = ` (${notes.map((note) => note.replace(/[\r\n]+/g, ' ')).join('; ')})`

    return `${String(row.displayed)} ${String(row.destination)}${suffix}`
  })

  if (rows.length) {
    start = args.offset + 1
    end = args.offset + rows.length
  }

  let continuation = 'end'

  if (end && end < total) continuation = `next offset: ${end}`
  lines.push(`${start}–${end} of ${total}; ${continuation}`)

  return lines.join('\n')
}
