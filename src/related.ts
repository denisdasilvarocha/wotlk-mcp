import { relations } from './schema.js'
import { pageFooter } from './search.js'

import type { Database } from './database.js'

interface RelatedInput {
  id: string
  rel?: string
  limit: number
  offset: number
}

export function getRelated(db: Database, args: Readonly<RelatedInput>): string {
  const inverse = relations
    .map(([forward, reverse]) => `WHEN '${forward}' THEN '${reverse}'`)
    .join(' ')
  const neighborhood = `SELECT relation AS displayed, destination_id AS destination, notes FROM link WHERE source_id = ?
    UNION ALL
    SELECT CASE relation ${inverse} END AS displayed, source_id AS destination, notes FROM link WHERE destination_id = ?`
  const filter = "WHERE (? = '' OR displayed = ?)"
  const params = [args.id, args.id, args.rel ?? '', args.rel ?? ''] as const
  const total = Number(
    db.prepare(`SELECT count(*) AS total FROM (${neighborhood}) ${filter}`).get(...params)?.total
  )
  const rows = db
    .prepare(`SELECT displayed, destination, notes FROM (${neighborhood}) ${filter}
    ORDER BY displayed COLLATE BINARY, destination COLLATE BINARY LIMIT ? OFFSET ?`)
    .all(...params, args.limit, args.offset)
  const lines = rows.map((row) => {
    const notes: string[] = row.notes ? JSON.parse(String(row.notes)) : []
    const suffix =
      notes.length > 0
        ? ` (${notes.map((note) => note.replaceAll(/[\r\n]+/gu, ' ')).join('; ')})`
        : ''

    return `${String(row.displayed)} ${String(row.destination)}${suffix}`
  })

  return [...lines, pageFooter(args.offset, rows.length, total)].join('\n')
}
