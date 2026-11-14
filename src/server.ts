import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'

import { getReferencePath } from './acquire.js'
import { getRecords, openReference } from './reference.js'
import { getRelated, parseRelated, relatedTool } from './related.js'
import { kinds } from './schema.js'
import { runSql } from './sql.js'

const idPattern = `^(${kinds.join('|')}):.+$`
const input = z.strictObject({
  ids: z
    .array(z.string().regex(new RegExp(idPattern)))
    .min(1)
    .max(20)
})
const sqlInput = z.strictObject({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(1000).default(100)
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
    {
      name: 'sql',
      description:
        'Run one read-only SQL statement. Discover tables in sqlite_schema and with table_info, table_xinfo, table_list, index_list or foreign_key_list PRAGMAs. Source tables use dbc_, world_, lua_, offsets_ and ui_ prefixes. Cells escape backslash, tab, newline and carriage return; NULL is null, \\NULL is literal text NULL, and blobs are \\x followed by hex.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }
        },
        required: ['query'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    relatedTool
  ]
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (request.params.name === 'sql') {
      const parsed = sqlInput.safeParse(request.params.arguments)
      if (!parsed.success) throw new Error('sql requires a query and an integer limit of 1–1000')
      const path = await getReferencePath()
      return { content: [{ type: 'text', text: await runSql(path, parsed.data.query, parsed.data.limit) }] }
    }
    if (request.params.name === 'related') {
      const args = parseRelated(request.params.arguments)
      const db = openReference()
      try {
        return { content: [{ type: 'text', text: getRelated(db, args) }] }
      } finally {
        db.close()
      }
    }
    if (request.params.name !== 'get') throw new Error('unknown tool; use get, sql or related')
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
