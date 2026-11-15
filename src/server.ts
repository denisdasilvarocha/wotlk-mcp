import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'

import { getReferencePath, takeUpdateWarning } from './acquire.js'
import { getRecords, openReference } from './reference.js'
import { getRelated } from './related.js'
import { kinds, relations } from './schema.js'
import { searchRecords } from './search.js'
import { runSql } from './sql.js'

const searchInput = z.strictObject({
  query: z.string().trim().min(1),
  kind: z.array(z.enum(kinds)).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0)
})

const idPattern = `^(${kinds.join('|')}):.+$`

const getInput = z.strictObject({
  ids: z
    .array(z.string().regex(new RegExp(idPattern)))
    .min(1)
    .max(20),
  from: z.number().int().min(1).optional(),
  to: z.number().int().min(1).optional()
})

const relationNames = relations.flat()

const relatedInput = z.strictObject({
  id: z.string().regex(new RegExp(idPattern)),
  rel: z
    .string()
    .refine((value) => relationNames.includes(value))
    .optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().nonnegative().default(0)
})

const sqlInput = z.strictObject({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(1000).default(100)
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
    {
      name: 'related',
      description: 'Navigate one-hop Links in either direction. Results are compact and paginated.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: idPattern },
          rel: { type: 'string', enum: relationNames },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 }
        },
        required: ['id'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await (async (): Promise<CallToolResult> => {
    try {
      if (request.params.name === 'sql') {
        const parsed = sqlInput.safeParse(request.params.arguments)

        if (!parsed.success) throw new Error('sql requires a query and an integer limit of 1–1000')

        const path = await getReferencePath()

        return {
          content: [
            { type: 'text', text: await runSql(path, parsed.data.query, parsed.data.limit) }
          ]
        }
      }

      if (request.params.name === 'related') {
        const parsed = relatedInput.safeParse(request.params.arguments)

        if (!parsed.success)
          throw new Error(
            `related requires a valid ID, relation, limit 1–100 and nonnegative integer offset; valid kinds: ${kinds.join(', ')}; valid relations: ${relationNames.join(', ')}`
          )

        const db = openReference(await getReferencePath())

        try {
          return { content: [{ type: 'text', text: getRelated(db, parsed.data) }] }
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

      if (request.params.name !== 'get')
        throw new Error('unknown tool; use get, related, search or sql')

      const parsed = getInput.safeParse(request.params.arguments)

      if (!parsed.success)
        throw new Error(
          `get requires 1–20 valid IDs and positive integer from/to bounds; valid kinds: ${kinds.join(', ')}`
        )

      const db = openReference(await getReferencePath())

      try {
        return {
          content: [
            {
              type: 'text',
              text: getRecords(db, parsed.data.ids, parsed.data.from, parsed.data.to)
            }
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
  })()
  const warning = takeUpdateWarning()

  if (warning) result.content.push({ type: 'text', text: warning })

  return result
})

await server.connect(new StdioServerTransport())
