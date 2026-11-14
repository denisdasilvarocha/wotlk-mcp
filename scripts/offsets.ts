import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import * as z from 'zod'

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

export function loadOffsets(directory: string): OffsetEntry[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .toSorted()
  if (files.length === 0) throw new Error(`No topic JSON documents in ${directory}`)
  const paths = new Set<string>()
  const offsets: OffsetEntry[] = []
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
