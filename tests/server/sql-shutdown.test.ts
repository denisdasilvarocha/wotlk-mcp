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
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-sql-shutdown-'))
const database = path.join(directory, 'reference.sqlite')
const entry = path.join(directory, 'package/dist/index.mjs')
const preload = path.join(directory, 'sql-lifecycle-preload.mjs')

beforeAll(() => {
  initReference(database)
  unpackPackage(directory)
  writeFileSync(
    preload,
    `import { once } from 'node:events';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const socket = createConnection(Number(process.env.TEST_SQL_PORT), '127.0.0.1');
await once(socket, 'connect');
socket.unref();
const wait = new Int32Array(new SharedArrayBuffer(4));
if (process.argv[1] === process.env.TEST_SERVER_ENTRY) {
  socket.once('data', () => {
    socket.write('p');
    Atomics.wait(wait, 0, 0, 10000);
  });
  socket.write('s');
}
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (query) {
  if (query === 'SELECT 42 AS lifecycle_probe') {
    socket.write('q');
    Atomics.wait(wait, 0, 0, 10000);
  }
  return prepare.call(this, query);
};`
  )
})

afterAll(() => {
  rmSync(directory, { force: true, recursive: true })
})

async function withBlockedSql(
  verify: (server: Socket, worker: Socket, pid: number) => Promise<void>
): Promise<void> {
  const sockets = new Set<Socket>()
  const listener = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', (data) => listener.emit(data.toString(), socket))
  })
  const startup = AbortSignal.timeout(5000)
  const serverReady = once(listener, 's', { signal: startup })
  const queryReady = once(listener, 'q', { signal: startup })
  const ready = Promise.all([serverReady, queryReady])
  void ready.catch(() => {})
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Missing lifecycle probe address')
  }

  const client = new Client({ name: 'sql-lifecycle-test', version: '1' })
  const transport = new StdioClientTransport({
    args: [entry],
    command: process.execPath,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      TEST_SERVER_ENTRY: entry,
      TEST_SQL_PORT: String(address.port),
      WOTLK_MCP_DB: database
    }
  })
  try {
    await client.connect(transport)
    const pid = transport.pid
    if (pid === null) {
      throw new Error('Missing server PID')
    }
    const result = client.callTool({
      arguments: { query: 'SELECT 42 AS lifecycle_probe' },
      name: 'sql'
    })
    void result.catch(() => {})
    const [[server], [worker]]: [unknown[], unknown[]] = await ready
    if (!(server instanceof Socket) || !(worker instanceof Socket)) {
      throw new Error('Missing lifecycle probe sockets')
    }
    await verify(server, worker, pid)
  } finally {
    await client.close()
    for (const socket of sockets) {
      socket.destroy()
    }
    listener.close()
  }
}

function workerClosed(worker: Socket, timeoutMs: number): Promise<unknown> {
  return once(worker, 'close', { signal: AbortSignal.timeout(timeoutMs) })
}

test.each(['SIGINT', 'SIGTERM', 'SIGKILL'] as const)(
  'packed SQL stops an active query promptly when the server receives %s',
  async (signal) => {
    await expect(
      withBlockedSql(async (_server, worker, pid) => {
        const closed = workerClosed(worker, 2500)
        process.kill(pid, signal)
        await closed
      })
    ).resolves.toBeUndefined()
  },
  15000
)

test('packed SQL stops an active query at its deadline while the server cannot run timers', async () => {
  await withBlockedSql(async (server, worker, pid) => {
    const closed = workerClosed(worker, 7000)
    try {
      const paused = once(server, 'data', { signal: AbortSignal.timeout(2000) })
      server.write('pause')
      expect(await paused).toEqual([Buffer.from('p')])
      await closed
    } finally {
      process.kill(pid, 'SIGKILL')
    }
  })
}, 15000)
