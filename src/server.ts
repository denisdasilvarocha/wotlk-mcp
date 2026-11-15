import type { DatabaseSync } from 'node:sqlite'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'

import pkg from '../package.json' with { type: 'json' }
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

const relatedInput = z.strictObject({
  id: z.string().regex(new RegExp(idPattern)),
  rel: z.enum(relations.flat()).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().nonnegative().default(0)
})

const sqlInput = z.strictObject({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(1000).default(100)
})

interface Tool {
  description: string
  inputSchema: z.core.JSONSchema.JSONSchema
  run(args: unknown): Promise<string>
}

function tool<T extends z.ZodType>(
  description: string,
  input: T,
  run: (input: z.output<T>) => Promise<string>
): Tool {
  return {
    description,
    inputSchema: z.toJSONSchema(input, { io: 'input' }),
    async run(args) {
      const parsed = input.safeParse(args)

      if (!parsed.success) throw new Error(z.prettifyError(parsed.error))

      return run(parsed.data)
    }
  }
}

async function withReference(read: (db: DatabaseSync) => string): Promise<string> {
  const db = openReference(await getReferencePath())

  try {
    return read(db)
  } finally {
    db.close()
  }
}

const tools: Record<string, Tool> = {
  search: tool(
    'Find Records by literal terms with deterministic ranking and compact hints. Interface source requires an explicit file filter.',
    searchInput,
    async (input) => withReference((db) => searchRecords(db, input))
  ),
  get: tool(
    'Retrieve complete Records by ID, or numbered file windows of up to 200 lines. Empty values are omitted.',
    getInput,
    async (input) => withReference((db) => getRecords(db, input.ids, input.from, input.to))
  ),
  sql: tool(
    'Run one read-only SQL statement. Discover tables in sqlite_schema and with table_info, table_xinfo, table_list, index_list or foreign_key_list PRAGMAs. Source tables use dbc_, world_, lua_, offsets_ and ui_ prefixes. Cells escape backslash, tab, newline and carriage return; NULL is null, \\NULL is literal text NULL, and blobs are \\x followed by hex.',
    sqlInput,
    async (input) => runSql(await getReferencePath(), input.query, input.limit)
  ),
  related: tool(
    'Navigate one-hop Links in either direction. Results are compact and paginated.',
    relatedInput,
    async (input) => withReference((db) => getRelated(db, input))
  )
}

const server = new Server({ name: 'wotlk', version: pkg.version }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: Object.entries(tools).map(([name, { description, inputSchema }]) => ({
    name,
    description,
    inputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false }
  }))
}))

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  let result: CallToolResult

  try {
    if (!Object.hasOwn(tools, params.name))
      throw new Error('unknown tool; use get, related, search or sql')

    result = { content: [{ type: 'text', text: await tools[params.name].run(params.arguments) }] }
  } catch (error) {
    result = {
      isError: true,
      content: [{ type: 'text', text: String(error).replace(/[\r\n]+/g, ' ') }]
    }
  }

  const warning = takeUpdateWarning()

  if (warning) result.content.push({ type: 'text', text: warning })

  return result
})

await server.connect(new StdioServerTransport())
