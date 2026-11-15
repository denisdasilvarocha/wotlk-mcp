import type { DatabaseSync } from 'node:sqlite'

import { McpServer, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
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
    .max(20)
    .describe('Kind-qualified Record IDs, such as item:19019'),
  from: z.number().int().min(1).optional().describe('First line of a file window'),
  to: z.number().int().min(1).optional().describe('Last line of a file window')
})

const relatedInput = z.strictObject({
  id: z.string().regex(new RegExp(idPattern)),
  rel: z.enum(relations.flat()).optional().describe('Only follow this Link type'),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().nonnegative().default(0)
})

const sqlInput = z.strictObject({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(1000).default(100)
})

async function withReference(read: (db: DatabaseSync) => string): Promise<string> {
  const db = openReference(await getReferencePath())

  try {
    return read(db)
  } finally {
    db.close()
  }
}

// Tool errors stay one line; a pending update warning rides on the next result.
async function respond(run: () => Promise<string>): Promise<CallToolResult> {
  let result: CallToolResult

  try {
    result = { content: [{ type: 'text', text: await run() }] }
  } catch (error) {
    let text = String(error)

    if (error instanceof Error) text = error.message

    result = { isError: true, content: [{ type: 'text', text: text.replace(/[\r\n]+/g, ' ') }] }
  }

  const warning = takeUpdateWarning()

  if (warning) result.content.push({ type: 'text', text: warning })

  return result
}

const annotations: ToolAnnotations = { readOnlyHint: true, openWorldHint: false }

function createServer(): McpServer {
  const server = new McpServer({ name: 'wotlk', version: pkg.version })

  server.registerTool(
    'search',
    {
      title: 'Search Records',
      description:
        'Find Records by literal terms with deterministic ranking and compact hints. Interface source requires an explicit file filter.',
      inputSchema: searchInput,
      annotations
    },
    (input) => respond(() => withReference((db) => searchRecords(db, input)))
  )
  server.registerTool(
    'get',
    {
      title: 'Get Records',
      description:
        'Retrieve complete Records by ID, or numbered file windows of up to 200 lines. Empty values are omitted.',
      inputSchema: getInput,
      annotations
    },
    (input) => respond(() => withReference((db) => getRecords(db, input.ids, input.from, input.to)))
  )
  server.registerTool(
    'sql',
    {
      title: 'Query SQL',
      description:
        'Run one read-only SQL statement. Discover tables in sqlite_schema and with table_info, table_xinfo, table_list, index_list or foreign_key_list PRAGMAs. Source tables use dbc_, world_, lua_, offsets_ and ui_ prefixes. Cells escape backslash, tab, newline and carriage return; NULL is null, \\NULL is literal text NULL, and blobs are \\x followed by hex.',
      inputSchema: sqlInput,
      annotations
    },
    (input, ctx) =>
      respond(async () =>
        runSql(await getReferencePath(), input.query, input.limit, ctx.mcpReq.signal)
      )
  )
  server.registerTool(
    'related',
    {
      title: 'Related Records',
      description: 'Navigate one-hop Links in either direction. Results are compact and paginated.',
      inputSchema: relatedInput,
      annotations
    },
    (input) => respond(() => withReference((db) => getRelated(db, input)))
  )

  return server
}

serveStdio(createServer)
