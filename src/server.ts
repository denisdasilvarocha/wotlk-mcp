import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'

import { getReferencePath } from './acquire.js'
import { getRecords, openReference } from './reference.js'
import { getRelated, parseRelated, relatedTool } from './related.js'
import { kinds } from './schema.js'

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
    if (request.params.name !== 'get') throw new Error('unknown tool; use get or related')
    const parsed = input.safeParse(request.params.arguments)
    if (!parsed.success)
      throw new Error(`get requires 1–20 valid IDs; valid kinds: ${kinds.join(', ')}`)
    const db = openReference(await getReferencePath())
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
