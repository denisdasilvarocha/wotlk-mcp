import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync } from 'node:zlib'
import { afterAll, expect, test } from 'vite-plus/test'
import { z } from 'zod'

import type { AddressInfo } from 'node:net'

const { version, wotlkSchemaMajor } = z
  .object({
    version: z.string(),
    wotlkSchemaMajor: z.number()
  })
  .parse(JSON.parse(readFileSync('package.json', 'utf8')))
const tag = `v${version}`
const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-release-'))
afterAll(() => {
  rmSync(directory, { force: true, recursive: true })
})

function listen(server: Readonly<Server>): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('No server address'))
      } else {
        resolve(address)
      }
    })
  })
}

function run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      (error: { readonly message: string } | null, stdout: string, stderr: string): void => {
        if (error === null) {
          resolve({ stderr, stdout })
        } else {
          reject(new Error(error.message))
        }
      }
    )
  })
}

function respond(
  request: { readonly url?: string; readonly headers: { readonly accept?: string } },
  response: {
    readonly end: {
      (): unknown
      (data: string): unknown
      (data: string, encoding: 'latin1'): unknown
    }
    readonly writeHead: (status: number) => unknown
  },
  releases: readonly unknown[],
  versions: Readonly<Record<string, unknown>>,
  compressed: () => string
): void {
  if (request.url?.startsWith('/releases') === true) {
    response.end(JSON.stringify(releases))
  } else if (request.url === '/package') {
    response.end(JSON.stringify({ versions }))
  } else if (request.url === '/asset' && request.headers.accept === 'application/octet-stream') {
    response.end(compressed(), 'latin1')
  } else {
    response.writeHead(404)
    response.end()
  }
}

test('release guard permits only an aligned tag with a published, verified compatible database', async () => {
  const dbPath = path.join(directory, 'reference.sqlite')
  const db = new DatabaseSync(dbPath)

  db.exec(
    `CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('schema_version', '${wotlkSchemaMajor}.0.0')`
  )
  db.close()

  const compressed = brotliCompressSync(readFileSync(dbPath))
  const digest = `sha256:${createHash('sha256').update(compressed).digest('hex')}`
  let releases: unknown[] = []
  let versions: Record<string, unknown> = {}
  const server = createServer(
    (
      request: { readonly url?: string; readonly headers: { readonly accept?: string } },
      response: {
        readonly end: {
          (): unknown
          (data: string): unknown
          (data: string, encoding: 'latin1'): unknown
        }
        readonly writeHead: (status: number) => unknown
      }
    ) => {
      respond(request, response, releases, versions, () => compressed.toString('latin1'))
    }
  )

  const address = await listen(server)

  const base = `http://127.0.0.1:${address.port}`

  function command(releaseTag: string): ReturnType<typeof run> {
    return run(process.execPath, [
      'scripts/check-package-release.mjs',
      releaseTag,
      `${base}/releases`,
      `${base}/package`
    ])
  }

  try {
    await expect(command(version)).rejects.toThrow('tag')
    await expect(command(tag)).rejects.toThrow('published')
    releases = [
      {
        assets: [{ digest, name: 'wotlk.sqlite.br', url: `${base}/asset` }],
        draft: true,
        prerelease: false,
        tag_name: `db-v${wotlkSchemaMajor}.0.0`
      }
    ]
    await expect(command(tag)).rejects.toThrow('published')
    releases = [
      {
        assets: [{ digest: 'sha256:bad', name: 'wotlk.sqlite.br', url: `${base}/asset` }],
        draft: false,
        prerelease: false,
        tag_name: `db-v${wotlkSchemaMajor}.0.0`
      }
    ]
    await expect(command(tag)).rejects.toThrow('digest')
    releases = [
      {
        assets: [
          {
            digest: `sha256:${'0'.repeat(64)}`,
            name: 'wotlk.sqlite.br',
            url: `${base}/asset`
          }
        ],
        draft: false,
        prerelease: false,
        tag_name: `db-v${wotlkSchemaMajor}.0.0`
      }
    ]
    await expect(command(tag)).rejects.toThrow('database asset digest mismatch')
    releases = [
      {
        assets: [{ digest, name: 'wotlk.sqlite.br', url: `${base}/asset` }],
        draft: false,
        prerelease: false,
        tag_name: `db-v${wotlkSchemaMajor}.0.0`
      }
    ]

    const otherVersion = `${version.split('.')[0]}.999999.0`

    versions = { [otherVersion]: { wotlkSchemaMajor } }

    const result = await command(tag)

    expect(result.stdout).toContain(
      `Package ${tag} has a published compatible schema ${wotlkSchemaMajor} database`
    )
    versions = { [otherVersion]: { wotlkSchemaMajor: wotlkSchemaMajor + 1 } }
    await expect(command(tag)).rejects.toThrow(
      'schema major changed without a package-major change'
    )
    versions = { [version]: { wotlkSchemaMajor } }
    await expect(command(tag)).rejects.toThrow('already')
  } finally {
    server.close()
  }
})
