import { initReference } from '../../build/offsets.ts'
import { unpackPackage } from '../helpers/package.ts'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vite-plus/test'

test('packed SQL admits a queued query after an active worker closes', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-sql-admission-'))
  const database = path.join(directory, 'reference.sqlite')
  const entry = path.join(directory, 'package/dist/index.mjs')
  const preload = path.join(directory, 'preload.mjs')
  const sockets = new Set<Socket>()
  const listener = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', (data) => listener.emit(data.toString()))
  })
  const startup = AbortSignal.timeout(5000)
  const started = [1, 2, 3, 4, 5].map((id) => once(listener, String(id), { signal: startup }))
  void Promise.all(started).catch(() => {})
  let client: Client | undefined

  try {
    initReference(database)
    unpackPackage(directory)
    writeFileSync(
      preload,
      `import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
if (process.argv[1] !== process.env.TEST_SERVER_ENTRY) {
  const socket = createConnection(Number(process.env.TEST_SQL_PORT), '127.0.0.1');
  await once(socket, 'connect');
  socket.unref();
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (query) {
    const match = /^SELECT ([1-5]) AS admission_probe$/.exec(query);
    if (match) {
      socket.write(match[1]);
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(path.join(process.env.TEST_GATE_DIRECTORY, match[1]))) {
        Atomics.wait(wait, 0, 0, 10);
      }
    }
    return prepare.call(this, query);
  };
}`
    )
    listener.listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const address = listener.address()
    if (address === null || typeof address === 'string') throw new Error('Missing probe address')
    client = new Client({ name: 'sql-admission-test', version: '1' })
    await client.connect(
      new StdioClientTransport({
        args: [entry],
        command: process.execPath,
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          TEST_GATE_DIRECTORY: directory,
          TEST_SERVER_ENTRY: entry,
          TEST_SQL_PORT: String(address.port),
          WOTLK_MCP_DB: database
        }
      })
    )

    const results = [1, 2, 3, 4, 5].map((id) =>
      client!.callTool({ arguments: { query: `SELECT ${id} AS admission_probe` }, name: 'sql' })
    )
    void Promise.all(results).catch(() => {})
    await Promise.all(started.slice(0, 4))
    writeFileSync(path.join(directory, '1'), '')
    const first = await results[0]
    await started[4]
    for (const id of [2, 3, 4, 5]) writeFileSync(path.join(directory, String(id)), '')
    const remaining = await Promise.all(results.slice(1))
    expect(remaining.map((result) => result.content)).toEqual([
      [{ text: 'admission_probe\n2', type: 'text' }],
      [{ text: 'admission_probe\n3', type: 'text' }],
      [{ text: 'admission_probe\n4', type: 'text' }],
      [{ text: 'admission_probe\n5', type: 'text' }]
    ])
    expect(first.content).toEqual([{ text: 'admission_probe\n1', type: 'text' }])
  } finally {
    for (const id of [1, 2, 3, 4, 5]) writeFileSync(path.join(directory, String(id)), '')
    await client?.close()
    for (const socket of sockets) socket.destroy()
    listener.close()
    rmSync(directory, { force: true, recursive: true })
  }
}, 15000)
