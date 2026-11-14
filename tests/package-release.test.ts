import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
        assets: [{ name: 'wotlk.sqlite.br', digest, browser_download_url: `${base}/asset` }]
      }
    ]
    versions = { '0.9.0': { wotlkSchemaMajor: 2 } }
    await expect(command(tag)).resolves.toHaveProperty('stdout')
    versions = { [version]: { wotlkSchemaMajor: wotlkSchemaMajor + 1 } }
    await expect(command(tag)).rejects.toThrow('already')
    versions = { '0.9.0': { wotlkSchemaMajor }, [version]: { wotlkSchemaMajor } }
    await expect(command(tag)).rejects.toThrow('already')
  } finally {
    server.close()
  }
})

test('npm publishes the packed package only to an isolated controlled registry', async () => {
  const requests: { method: string | undefined; url: string | undefined; body: string }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body })
      response.setHeader('content-type', 'application/json')
      response.statusCode = 201
      response.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server address')
  try {
    await run('vp', ['pm', 'pack', '--pack-destination', directory])
    const archive = readdirSync(directory).find((name) => name.endsWith('.tgz'))
    if (!archive) throw new Error('Package archive not created')
    const config = path.join(directory, 'npmrc')
    writeFileSync(config, `//127.0.0.1:${address.port}/:_authToken=isolated-test-only\n`)
    await run(
      'npm',
      [
        'publish',
        path.join(directory, archive),
        '--ignore-scripts',
        '--registry',
        `http://127.0.0.1:${address.port}`,
        '--userconfig',
        config
      ],
      { cwd: directory }
    )
    const publication = requests.find(
      (request) => request.method === 'PUT' && request.url === '/wotlk-mcp'
    )
    expect(publication).toBeDefined()
    const payload = JSON.parse(publication?.body ?? '{}')
    expect(payload.versions[version].bin['wotlk-mcp']).toBe('dist/index.mjs')
    expect(payload['_attachments'][`wotlk-mcp-${version}.tgz`].data.length).toBeGreaterThan(0)
  } finally {
    server.close()
  }
}, 120_000)
