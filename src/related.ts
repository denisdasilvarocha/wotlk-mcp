import type { DatabaseSync } from 'node:sqlite'

import * as z from 'zod'

import { kinds, relations } from './schema.js'

const names = relations.flat()
const idPattern = `^(${kinds.join('|')}):.+$`
const input = z.strictObject({
  id: z.string().regex(new RegExp(idPattern)),
  rel: z
    .string()
    .refine((value) => names.includes(value))
    .optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().nonnegative().default(0)
})

export const relatedTool = {
  name: 'related',
  description: 'Navigate one-hop Links in either direction. Results are compact and paginated.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', pattern: idPattern },
      rel: { type: 'string', enum: names },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 }
    },
    required: ['id'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}

export function parseRelated(args: unknown): z.infer<typeof input> {
  const result = input.safeParse(args)
  if (!result.success)
    throw new Error(
      `related requires a valid ID, relation, limit 1–100 and nonnegative integer offset; valid kinds: ${kinds.join(', ')}; valid relations: ${names.join(', ')}`
    )
  return result.data
}

export function getRelated(db: DatabaseSync, args: z.infer<typeof input>): string {
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
    let notes: string[] = []
    if (row.notes) notes = JSON.parse(String(row.notes))
    let suffix = ''
    if (notes.length) suffix = ` (${notes.map((note) => note.replace(/[\r\n]+/g, ' ')).join('; ')})`
    return `${String(row.displayed)} ${String(row.destination)}${suffix}`
  })
  let start = 0
  let end = 0
  if (rows.length) {
    start = args.offset + 1
    end = args.offset + rows.length
  }
  let continuation = 'end'
  if (end && end < total) continuation = `next offset: ${end}`
  lines.push(`${start}–${end} of ${total}; ${continuation}`)
  return lines.join('\n')
}
