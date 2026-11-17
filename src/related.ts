import { relations } from './schema.js'

import type { Database } from './database.js'

interface RelatedInput {
  id: string
  rel?: string
  limit: number
  offset: number
}

function renderRelatedRow(
  row: Readonly<
    Record<string, null | number | bigint | string | Readonly<Pick<Uint8Array, 'toString'>>>
  >
): string {
  const parseNotes: (value: string) => string[] = JSON.parse
  let notes: string[] = []

  if (
    row.notes !== null &&
    row.notes !== undefined &&
    row.notes !== '' &&
    row.notes !== 0 &&
    row.notes !== 0n
  ) {
    notes = parseNotes(String(row.notes))
  }

  let suffix = ''

  if (notes.length > 0) {
    suffix = ` (${notes.map((note) => note.replaceAll(/[\r\n]+/gu, ' ')).join('; ')})`
  }

  return `${String(row.displayed)} ${String(row.destination)}${suffix}`
}

export function getRelated(db: Database, args: Readonly<RelatedInput>): string {
  let end = 0
  const filter = "WHERE (? = '' OR displayed = ?)"
  const inverse = relations
    .map(([forward, reverse]: readonly string[]) => `WHEN '${forward}' THEN '${reverse}'`)
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
  const lines = rows.map((row: Parameters<typeof renderRelatedRow>[0]) => renderRelatedRow(row))

  if (rows.length > 0) {
    start = args.offset + 1
    end = args.offset + rows.length
  }

  let continuation = 'end'

  if (end && end < total) {
    continuation = `next offset: ${end}`
  }
  lines.push(`${start}–${end} of ${total}; ${continuation}`)

  return lines.join('\n')
}
