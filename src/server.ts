import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'

import { getRecords, openReference } from './reference.js'
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
    .max(20)
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
      description: 'Retrieve complete Records by ID. Empty values are omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: 'string', pattern: idPattern }
          }
        },
        required: ['ids'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    }
  ]
}))
server.setRequestHandler(CallToolRequestSchema, (request) => {
  try {
    if (request.params.name === 'search') {
      const parsed = searchInput.safeParse(request.params.arguments)
      if (!parsed.success)
        throw new Error(
          `search requires a nonempty query, valid kinds (${kinds.join(', ')}), limit 1–100 and nonnegative integer offset`
        )
      const db = openReference()
      try {
        return { content: [{ type: 'text', text: searchRecords(db, parsed.data) }] }
      } finally {
        db.close()
      }
    }
    if (request.params.name !== 'get') throw new Error('unknown tool; use get')
    const parsed = input.safeParse(request.params.arguments)
    if (!parsed.success)
      throw new Error(`get requires 1–20 valid IDs; valid kinds: ${kinds.join(', ')}`)
    const db = openReference()
    try {
      return { content: [{ type: 'text', text: getRecords(db, parsed.data.ids) }] }
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
