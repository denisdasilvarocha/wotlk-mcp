import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as z from 'zod'

export const kinds = [
  'spell',
  'talent',
  'itemset',
  'skillline',
  'map',
  'area',
  'faction',
  'class',
  'race',
  'achievement',
  'creature',
  'item',
  'quest',
  'gameobject',
  'fn',
  'event',
  'widget',
  'method',
  'cvar',
  'type',
  'cle',
  'template',
  'slash',
  'offset',
  'file'
]

export const relations = [
  'drops',
  'dropped by',
  'starts',
  'started by',
  'ends',
  'ended by',
  'rewards',
  'rewarded by',
  'sells',
  'sold by',
  'teaches',
  'taught by',
  'casts',
  'cast by',
  'contains',
  'contained in',
  'grants',
  'granted by',
  'belongs to',
  'includes',
  'faction',
  'faction of',
  'spawns in',
  'spawns',
  'implemented by',
  'implements'
]
const approval = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unapproved') }),
  z.strictObject({
    date: z.iso.date(),
    fixtures_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    record: z.url(),
    reviewer: z.string().trim().min(2),
    status: z.literal('approved'),
    world_cases: z.array(z.string().min(1)).min(1)
  })
])
export function approvalFailure(
  digest: () => string,
  fixtures: readonly Readonly<{ domain: string; id: string }>[]
): string | undefined {
  const recordPath = fileURLToPath(
    new URL('../data/world-acceptance-approval.json', import.meta.url)
  )
  const record = approval.parse(JSON.parse(readFileSync(recordPath, 'utf8')))

  if (record.status === 'approved') {
    if (
      record.fixtures_sha256 !== digest() ||
      JSON.stringify(record.world_cases.toSorted()) !==
        JSON.stringify(
          fixtures
            .filter((f) => f.domain === 'world')
            .map((f) => f.id)
            .toSorted()
        )
    ) {
      return 'UNAPPROVED World Data: approval does not cover these exact fixtures and case IDs'
    }
  } else {
    return 'UNAPPROVED World Data: maintainer review and durable approval of exact cases are required; see docs/world-data-facts.md and #45'
  }

  return undefined
}
