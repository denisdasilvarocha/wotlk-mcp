import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import { getRecords, openReference } from './reference.js'

const server = new McpServer({ name: 'wotlk', version: '1.0.0' })
server.registerTool('get', {
  description: 'Retrieve complete Records by ID. Empty values are omitted.',
  inputSchema: { ids: z.array(z.string()).min(1).max(20) },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, ({ ids }) => {
  try {
    const db = openReference()
    try {
      return { content: [{ type: 'text', text: getRecords(db, ids) }] }
    } finally {
      db.close()
    }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error).replace(/[\r\n]+/g, ' ') }] }
  }
})
await server.connect(new StdioServerTransport())
