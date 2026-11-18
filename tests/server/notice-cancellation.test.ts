import { initReference } from '../../build/offsets.ts'
import { publish } from '../../src/acquire/cache.ts'
import { unpackPackage } from '../helpers/package.ts'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-notice-'))
const client = new Client({ name: 'notice-cancellation-test', version: '1' })
const transport = new StdioClientTransport({
  args: [path.join(directory, 'package/dist/index.mjs')],
  command: process.execPath,
  env: { HOME: directory, LOCALAPPDATA: directory, XDG_CACHE_HOME: directory }
})

beforeAll(async () => {
  const root = process.platform === 'darwin' ? path.join(directory, 'Library', 'Caches') : directory
  const cache = path.join(root, 'wotlk-mcp', 'schema-1')
  const file = 'db-v1.0.0-0.sqlite'
  const lastCheck = Date.now()

  mkdirSync(cache, { recursive: true })
  initReference(path.join(cache, file))
  await publish(cache, { file, lastCheck, version: 'db-v1.0.0', warningMajor: 2 }, lastCheck)
  unpackPackage(directory)
  await client.connect(transport)
})

afterAll(async () => {
  await client.close()
  rmSync(directory, { force: true, recursive: true })
})

test('the next delivered SQL result carries the notice once after cancellation', async () => {
  const id = 10_000
  const note = 'note: newer reference data needs wotlk-mcp@2; update your config'
  const next = { arguments: { query: 'SELECT 1 AS value' }, name: 'sql' }

  await transport.send({
    id,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      arguments: {
        query: 'WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n'
      },
      name: 'sql'
    }
  })
  await transport.send({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: id }
  })
  const delivered = await client.callTool(next)
  const subsequent = await client.callTool(next)

  expect(delivered.content).toEqual([
    { text: 'value\n1', type: 'text' },
    { text: note, type: 'text' }
  ])
  expect(subsequent.content).toEqual([{ text: 'value\n1', type: 'text' }])
})
