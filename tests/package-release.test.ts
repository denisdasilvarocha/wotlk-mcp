import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { brotliCompressSync } from 'node:zlib'

import { afterAll, expect, test } from 'vite-plus/test'

const { version, wotlkSchemaMajor } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${version}`
const run = promisify(execFile)
const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-release-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

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
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/releases')) response.end(JSON.stringify(releases))
    else if (request.url === '/package') response.end(JSON.stringify({ versions }))
    else if (request.url === '/asset') response.end(compressed)
    else {
      response.statusCode = 404
      response.end()
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()

  if (!address || typeof address === 'string') throw new Error('No server address')

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
        tag_name: `db-v${wotlkSchemaMajor}.0.0`,
        draft: true,
        prerelease: false,
        assets: [{ name: 'wotlk.sqlite.br', digest, browser_download_url: `${base}/asset` }]
      }
    ]
    await expect(command(tag)).rejects.toThrow('published')
    releases = [
      {
        tag_name: `db-v${wotlkSchemaMajor}.0.0`,
        draft: false,
        prerelease: false,
        assets: [
          { name: 'wotlk.sqlite.br', digest: 'sha256:bad', browser_download_url: `${base}/asset` }
        ]
      }
    ]
    await expect(command(tag)).rejects.toThrow('digest')
    releases = [
      {
        tag_name: `db-v${wotlkSchemaMajor}.0.0`,
        draft: false,
        prerelease: false,
        assets: [
          {
            name: 'wotlk.sqlite.br',
            digest: `sha256:${'0'.repeat(64)}`,
            browser_download_url: `${base}/asset`
          }
        ]
      }
    ]
    await expect(command(tag)).rejects.toThrow('database asset digest mismatch')
    releases = [
      {
        tag_name: `db-v${wotlkSchemaMajor}.0.0`,
        draft: false,
        prerelease: false,
        assets: [{ name: 'wotlk.sqlite.br', digest, browser_download_url: `${base}/asset` }]
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
