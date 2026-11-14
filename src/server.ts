import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'

import { getReferencePath } from './acquire.js'
import { getRecords, openReference } from './reference.js'
import { getRelated, parseRelated, relatedTool } from './related.js'
import { kinds } from './schema.js'
import { searchRecords } from './search.js'

const searchInput = z.strictObject({
  query: z.string().trim().min(1),
  kind: z.array(z.enum(kinds)).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0)
})

const idPattern = `^(${kinds.join('|')}):.+$`
const input = z.strictObject({
  ids: z
    .array(z.string().regex(new RegExp(idPattern)))
    .min(1)
    .max(20),
  from: z.number().int().min(1).optional(),
  to: z.number().int().min(1).optional()
})
const server = new Server({ name: 'wotlk', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'search',
      description:
        'Find Records by literal terms with deterministic ranking and compact hints. Interface source requires an explicit file filter.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          kind: { type: 'array', items: { type: 'string', enum: kinds } },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 }
        },
        required: ['query'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    {
      name: 'get',
      description:
        'Retrieve complete Records by ID, or numbered file windows. Empty values are omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: 'string', pattern: idPattern }
          },
          from: { type: 'integer', minimum: 1 },
          to: { type: 'integer', minimum: 1 }
        },
        required: ['ids'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    relatedTool
  ]
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (request.params.name === 'related') {
      const args = parseRelated(request.params.arguments)
      const db = openReference(await getReferencePath())
      try {
        return { content: [{ type: 'text', text: getRelated(db, args) }] }
      } finally {
        db.close()
      }
    }
    if (request.params.name === 'search') {
      const parsed = searchInput.safeParse(request.params.arguments)
      if (!parsed.success)
        throw new Error(
          `search requires a nonempty query, valid kinds (${kinds.join(', ')}), limit 1–100 and nonnegative integer offset`
        )
      const db = openReference(await getReferencePath())
      try {
        return { content: [{ type: 'text', text: searchRecords(db, parsed.data) }] }
      } finally {
        db.close()
      }
    }
    if (request.params.name !== 'get') throw new Error('unknown tool; use get, related or search')
    const parsed = input.safeParse(request.params.arguments)
    if (!parsed.success)
      throw new Error(
        `get requires 1–20 valid IDs and positive integer from/to bounds; valid kinds: ${kinds.join(', ')}`
      )
    const db = openReference(await getReferencePath())
    try {
      return {
        content: [
          { type: 'text', text: getRecords(db, parsed.data.ids, parsed.data.from, parsed.data.to) }
        ]
      }
    } finally {
      db.close()
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: String(error).replace(/[\r\n]+/g, ' ') }]
    }
  }
})
await server.connect(new StdioServerTransport())
