import { createReleaseFixture, sealReleaseFixture } from '../helpers/release-fixture.ts'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync } from 'node:zlib'
import { expect, test } from 'vite-plus/test'

type DeepReadonly<T> = T extends (...args: readonly never[]) => unknown
  ? T
  : { readonly [K in keyof T]: DeepReadonly<T[K]> }

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('expected JSON object')
  }

  return Object.fromEntries(Object.entries(value))
}

async function releaseScenario(
  scenario: 'authorization' | 'download' | 'reserved'
): Promise<unknown> {
  const dir = mkdtempSync(path.join(tmpdir(), 'db-release-'))
  const sqlite = path.join(dir, 'source.sqlite')

  createReleaseFixture(sqlite)
  sealReleaseFixture(sqlite)

  const asset = brotliCompressSync(readFileSync(sqlite))
  let corruptDownload = false
  const digest = `sha256:${createHash('sha256').update(asset).digest('hex')}`
  let failedCell = -1
  let matrixScenario = 'normal'
  let promotions = 0
  let protectedEnvironment = true
  let release: Record<string, unknown> | undefined
  let reservedReleases: Record<string, unknown>[] = [
    {
      assets: [{ digest: null, id: 1, name: 'historical.tgz', state: 'uploaded' }],
      draft: false,
      prerelease: false,
      published_at: '2025-01-01T00:00:00Z',
      tag_name: 'v0.0.0'
    }
  ]
  let tags: { readonly name: string }[] = []
  const uploaded = new Map<number, Buffer>()
  const server = createServer()

  server.on(
    'request',
    (request: DeepReadonly<IncomingMessage>, response: DeepReadonly<ServerResponse>) => {
      void handleRequest(request, response)
    }
  )

  async function handleRequest(
    request: DeepReadonly<IncomingMessage>,
    response: DeepReadonly<ServerResponse>
  ): Promise<void> {
    const chunks: Buffer[] = []
    const url = new URL(request.url ?? '/', 'http://localhost')

    for await (const chunk of request as AsyncIterable<unknown>) {
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError('expected buffer')
      }
      chunks.push(chunk)
    }

    const body = Buffer.concat(chunks)

    function json(value: unknown, status = 200): void {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }

    if (url.pathname === '/repos/test/repo/environments/database-publication') {
      const rules = []

      if (protectedEnvironment) {
        rules.push({
          reviewers: [{ reviewer: { login: 'test' }, type: 'User' }],
          type: 'required_reviewers'
        })
      }

      json({ protection_rules: rules })
      return
    }

    if (url.pathname === '/repos/test/repo/releases' && request.method === 'GET') {
      const releases = [...reservedReleases]

      if (release) {
        releases.push(release)
      }

      const page = Number(url.searchParams.get('page'))

      json(releases.slice((page - 1) * 100, page * 100))
      return
    }

    if (url.pathname === '/repos/test/repo/tags') {
      const page = Number(url.searchParams.get('page'))

      json(tags.slice((page - 1) * 100, page * 100))
      return
    }

    if (url.pathname.startsWith('/repos/test/repo/git/ref/tags/')) {
      const name = url.pathname.split('/').at(-1)

      if (tags.some(({ name: tagName }) => tagName === name)) {
        json({ ref: `refs/tags/${name}` })
        return
      }

      json({}, 404)
      return
    }

    if (url.pathname === '/repos/test/repo/releases' && request.method === 'POST') {
      release = {
        id: 7,
        ...parseObject(body.toString()),
        assets: [],
        upload_url: `${origin}/upload{?name,label}`
      }

      json(release, 201)
      return
    }

    if (url.pathname === '/upload' && request.method === 'POST') {
      const name = url.searchParams.get('name')
      const item = {
        digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        id: uploaded.size + 11,
        name,
        state: 'uploaded'
      }

      uploaded.set(item.id, body)

      if (!Array.isArray(release?.assets)) {
        throw new TypeError('missing release assets')
      }

      release.assets.push(item)

      json(item, 201)
      return
    }

    if (url.pathname === '/repos/test/repo/releases/7' && request.method === 'GET') {
      json(release)
      return
    }

    if (url.pathname.startsWith('/repos/test/repo/releases/assets/')) {
      const bytes = uploaded.get(Number(url.pathname.split('/').at(-1)))

      if (!bytes) {
        json({}, 404)
        return
      }

      response.writeHead(200, { 'content-type': 'application/octet-stream' })

      if (corruptDownload) {
        response.end(Buffer.from('corrupt download'))
        return
      }

      response.end(bytes)
      return
    }

    if (url.pathname === '/repos/test/repo/actions/runs/10/jobs') {
      const names = ['ubuntu-latest', 'macos-latest', 'windows-latest'].flatMap((os) =>
        ['24.15.0', 'latest'].map((node) => `acceptance (${os}, ${node})`)
      )
      const jobs = names.map((name, index) => ({
        conclusion: ['success', 'failure'][Number(index === failedCell)],
        name,
        run_attempt: 1,
        status: 'completed'
      }))

      if (matrixScenario === 'missing') {
        jobs.pop()
      } else if (matrixScenario === 'rerun-success') {
        jobs[0].conclusion = 'failure'
        jobs.unshift(
          ...Array.from({ length: 100 }, () => ({
            conclusion: 'success',
            name: 'unrelated',
            run_attempt: 1,
            status: 'completed'
          }))
        )
        jobs.push({ conclusion: 'success', name: names[0], run_attempt: 2, status: 'completed' })
      } else if (matrixScenario === 'rerun-failure') {
        jobs.push({ conclusion: 'failure', name: names[0], run_attempt: 2, status: 'completed' })
      } else if (matrixScenario === 'rerun-incomplete') {
        jobs.push({ conclusion: 'success', name: names[0], run_attempt: 2, status: 'in_progress' })
      } else if (matrixScenario === 'ambiguous') {
        jobs.push({ conclusion: 'success', name: names[0], run_attempt: 1, status: 'completed' })
      }

      if (url.searchParams.get('filter') !== 'all' || url.searchParams.get('per_page') !== '100') {
        json({}, 400)
        return
      }
      const page = Number(url.searchParams.get('page'))
      json({ jobs: jobs.slice((page - 1) * 100, page * 100), total_count: jobs.length })
      return
    }

    if (url.pathname === '/repos/test/repo/releases/7' && request.method === 'PATCH') {
      const update = parseObject(body.toString())

      if (update.draft === false) {
        promotions++
        update.published_at = '2026-01-01T00:00:00Z'
      }

      Object.assign(release ?? {}, update)

      json(release)
      return
    }

    if (url.pathname === '/repos/test/repo/releases/7' && request.method === 'DELETE') {
      release = undefined
      response.writeHead(204)

      response.end()
      return
    }

    json({ message: 'not found' }, 404)
  }

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()

  if (address === null || typeof address === 'string') {
    throw new Error('missing server address')
  }

  const origin = `http://127.0.0.1:${address.port}`

  function run(
    args: readonly string[],
    authorized = true
  ): Promise<{ status: number | null; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/database-release.mjs', ...args], {
        env: {
          ...process.env,
          DATABASE_RELEASE_AUTHORIZATION: ['', 'owner-authorized'][Number(authorized)],
          GITHUB_API_URL: origin,
          GITHUB_REPOSITORY: 'test/repo',
          GITHUB_RUN_ID: '10',
          GITHUB_TOKEN: 'isolated'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.on('error', reject)
      child.on('close', (status) => {
        resolve({ status, stdout })
      })
    })
  }

  async function execute(): Promise<unknown> {
    const file = path.join(dir, 'wotlk.sqlite.br')

    writeFileSync(file, asset)

    const report = path.join(dir, 'gate.json')

    writeFileSync(
      report,
      execFileSync('vpx', ['scripts/release-gate.ts', sqlite, file], { encoding: 'utf8' })
    )

    const otherFiles = ['NOTICE.md', 'fidelity.json', 'build-report.json'].map((name) => {
      const item = path.join(dir, name)

      writeFileSync(item, name)

      return item
    })
    const files = [file, ...otherFiles, report]

    expect((await run(['previous', path.join(dir, 'previous.sqlite')])).status).toBe(0)

    async function authorization(): Promise<unknown> {
      expect((await run(['create', report, sqlite, ...files], false)).status).not.toBe(0)
      protectedEnvironment = false
      expect((await run(['create', report, sqlite, ...files])).status).not.toBe(0)
      protectedEnvironment = true
      writeFileSync(file, Buffer.from('corrupt asset'))
      expect((await run(['create', report, sqlite, ...files])).status).not.toBe(0)
      writeFileSync(file, asset)

      const validReport = readFileSync(report, 'utf8')
      const invalidReport = parseObject(validReport)

      invalidReport.version = '1.0.1'
      writeFileSync(report, JSON.stringify(invalidReport))
      expect((await run(['create', report, sqlite, ...files])).status).not.toBe(0)
      writeFileSync(report, validReport)
      expect(release).toBeUndefined()
      expect((await run(['create', report, sqlite, ...files])).status).toBe(0)

      return release?.draft
    }

    async function downloadAndPromote(): Promise<unknown> {
      expect((await run(['create', report, sqlite, ...files])).status).toBe(0)
      expect(release?.draft).toBe(true)

      const download = path.join(dir, 'download.br')

      expect((await run(['download', '7', digest, download])).status).toBe(0)
      expect(readFileSync(download)).toEqual(asset)
      expect(
        (await run(['download', '7', `sha256:${'0'.repeat(64)}`, path.join(dir, 'bad.br')])).status
      ).not.toBe(0)
      corruptDownload = true

      const corrupt = path.join(dir, 'corrupt.br')

      expect((await run(['download', '7', digest, corrupt])).status).not.toBe(0)
      expect(existsSync(corrupt)).toBe(false)
      expect(readdirSync(dir).filter((name) => name.startsWith('corrupt.br'))).toEqual([])
      corruptDownload = false

      async function checkFailedCell(index: number): Promise<void> {
        if (index === 6) {
          return
        }

        failedCell = index
        expect((await run(['promote', '7', 'db-v1.0.0', digest])).status).not.toBe(0)
        expect(promotions).toBe(0)
        await checkFailedCell(index + 1)
      }

      await checkFailedCell(0)
      failedCell = -1
      async function rejectMatrixCase(matrixCase: string): Promise<void> {
        matrixScenario = matrixCase
        expect((await run(['promote', '7', 'db-v1.0.0', digest])).status).not.toBe(0)
        expect(promotions).toBe(0)
      }
      await rejectMatrixCase('missing')
      await rejectMatrixCase('rerun-failure')
      await rejectMatrixCase('rerun-incomplete')
      await rejectMatrixCase('ambiguous')
      matrixScenario = 'rerun-success'
      expect((await run(['promote', '7', 'db-v1.0.0', digest], false)).status).not.toBe(0)
      expect((await run(['promote', '7', 'db-v1.0.1', digest])).status).not.toBe(0)
      expect((await run(['promote', '7', 'db-v1.0.0', digest])).status).toBe(0)
      expect(promotions).toBe(1)
      expect((await run(['promote', '7', 'db-v1.0.0', digest])).status).not.toBe(0)
      expect((await run(['create', report, sqlite, ...files])).status).not.toBe(0)
      expect(promotions).toBe(1)

      const previous = path.join(dir, 'previous.sqlite')

      expect((await run(['previous', previous])).status).toBe(0)
      expect(readFileSync(previous)).toEqual(readFileSync(sqlite))
      expect((await run(['rollback', '7', 'db-v1.0.1', 'prerelease'])).status).not.toBe(0)
      expect((await run(['rollback', '7', 'db-v1.0.0', 'prerelease'], false)).status).not.toBe(0)
      expect((await run(['rollback', '7', 'db-v1.0.0', 'prerelease'])).status).toBe(0)
      expect(release?.prerelease).toBe(true)
      expect((await run(['rollback', '7', 'db-v1.0.0', 'delete'])).status).toBe(0)

      return release
    }

    async function reserved(): Promise<unknown> {
      expect((await run(['create', report, sqlite, ...files])).status).toBe(0)
      expect((await run(['promote', '7', 'db-v1.0.0', digest])).status).toBe(0)

      const published = { ...release }

      async function checkReservedVersion(withdrawn: string): Promise<void> {
        release = { ...published }
        reservedReleases = []
        tags = [{ name: 'db-v1.0.0' }]

        if (withdrawn === 'deleted') {
          tags = Array.from({ length: 100 }, (_, index) => ({ name: `v0.0.${index}` }))
          tags.push({ name: 'db-v1.0.1' })
        } else {
          reservedReleases = Array.from({ length: 100 }, (_, index) => ({
            draft: true,
            tag_name: `v0.0.${index}`
          }))
          reservedReleases.push({
            draft: withdrawn === 'draft',
            prerelease: withdrawn === 'prerelease',
            tag_name: 'db-v1.0.1'
          })
        }

        const baseline = path.join(dir, `${withdrawn}.sqlite`)
        const versions = path.join(dir, `${withdrawn}.json`)
        const result = await run(['previous', baseline, versions])

        expect(result.status).toBe(0)
        expect(result.stdout.trim()).toBe('db-v1.0.0')
        expect(readFileSync(baseline)).toEqual(readFileSync(sqlite))
        expect(JSON.parse(readFileSync(versions, 'utf8'))).toContain('1.0.1')

        const candidate = path.join(dir, `${withdrawn}-candidate.sqlite`)

        writeFileSync(candidate, readFileSync(sqlite))

        const candidateDb = new DatabaseSync(candidate)

        candidateDb.exec('UPDATE meta SET value=\'{"fixture":"two"}\' WHERE key=\'input_pins\'')
        candidateDb.close()

        const gateArgs = [
          'scripts/release-gate.ts',
          candidate,
          file,
          baseline,
          `--used-versions=${versions}`
        ]

        execFileSync('vpx', [...gateArgs, '--prepare'])
        writeFileSync(file, brotliCompressSync(readFileSync(candidate)))
        writeFileSync(report, execFileSync('vpx', gateArgs))
        expect(parseObject(readFileSync(report, 'utf8')).version).toBe('1.0.2')
        expect((await run(['create', report, candidate, ...files])).status).toBe(0)
        expect(release?.tag_name).toBe('db-v1.0.2')
      }

      await checkReservedVersion('prerelease')
      await checkReservedVersion('deleted')
      await checkReservedVersion('draft')

      return release?.tag_name
    }

    return { authorization, download: downloadAndPromote, reserved }[scenario]()
  }

  try {
    return await execute()
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error: Readonly<Error> | undefined) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
    rmSync(dir, { force: true, recursive: true })
  }
}

test('authorization and create fail closed', async () => {
  expect(await releaseScenario('authorization')).toBe(true)
}, 30_000)

test('downloads and promotes only the verified draft', async () => {
  expect(await releaseScenario('download')).toBeUndefined()
}, 30_000)

test('withdrawn versions remain reserved', async () => {
  expect(await releaseScenario('reserved')).toBe('db-v1.0.2')
}, 30_000)
