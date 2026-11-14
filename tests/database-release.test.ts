import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync } from 'node:zlib'

import { expect, test } from 'vite-plus/test'

import { canonicalTableHash } from '../scripts/canonical-table-hash.ts'
import { kinds, relations } from '../src/schema.ts'

test('release commands fail closed and only promote the verified draft after six successful cells', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'db-release-'))
  const sqlite = path.join(dir, 'source.sqlite')
  const db = new DatabaseSync(sqlite)
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES('schema_version','1.0.0'),('input_pins','{"fixture":"one"}');
    CREATE TABLE source(name TEXT PRIMARY KEY,pin TEXT,sha256 TEXT,licence TEXT,attribution TEXT);
    INSERT INTO source VALUES('fixture','one','abc','test','test');
    CREATE TABLE record(id TEXT,kind TEXT,name TEXT,source_table TEXT,source_row INTEGER,search_text TEXT,hint TEXT);
    CREATE TABLE link(source_id TEXT,relation TEXT,destination_id TEXT,notes TEXT);
    CREATE TABLE entity(name TEXT); CREATE TABLE offsets_entry(path TEXT,va TEXT);
    CREATE TABLE lua_native_registration(record_id TEXT,va TEXT);
    CREATE TABLE ui_line(path TEXT,line INTEGER,text TEXT);
    CREATE VIRTUAL TABLE record_fts USING fts5(id UNINDEXED,name,text,tokenize='trigram');
    CREATE VIRTUAL TABLE ui_line_fts USING fts5(path UNINDEXED,line UNINDEXED,text,tokenize='trigram');`)
  for (const kind of kinds) {
    const row = db.prepare('INSERT INTO entity VALUES (?)').run(kind)
    db.prepare('INSERT INTO record VALUES (?,?,?,?,?,?,?)').run(
      `${kind}:1`,
      kind,
      kind,
      'entity',
      row.lastInsertRowid,
      '',
      ''
    )
    db.prepare('INSERT INTO record_fts VALUES (?,?,?)').run(`${kind}:1`, kind, '')
  }
  db.exec(
    "INSERT INTO offsets_entry VALUES ('one','0x00400000'); UPDATE record SET source_table='offsets_entry',source_row=1 WHERE id='offset:1'; INSERT INTO lua_native_registration VALUES ('fn:1','0x00400000'); INSERT INTO ui_line VALUES('test.lua',1,'hello'); INSERT INTO ui_line_fts VALUES('test.lua',1,'hello');"
  )
  for (const [relation] of relations) {
    let destination = 'item:1'
    if (relation === 'implemented by') destination = 'offset:1'
    db.prepare('INSERT INTO link VALUES (?,?,?,?)').run('fn:1', relation, destination, '')
  }
  for (const row of db
    .prepare(
      "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' AND name<>'meta'"
    )
    .all()) {
    const name = String(row.name)
    const { hash, count } = canonicalTableHash(db, name)
    db.prepare('INSERT INTO meta VALUES (?,?)').run(`canonical_hash.${name}`, hash)
    db.prepare('INSERT INTO meta VALUES (?,?)').run(`canonical_count.${name}`, count)
  }
  db.close()
  const asset = brotliCompressSync(readFileSync(sqlite))
  const digest = `sha256:${createHash('sha256').update(asset).digest('hex')}`
  let release: Record<string, unknown> | undefined
  let reservedReleases: Record<string, unknown>[] = []
  let tags: { name: string }[] = []
  let failedCell = -1
  let protectedEnvironment = true
  let promotions = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    function json(value: unknown, status = 200): void {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (url.pathname === '/repos/test/repo/environments/database-publication') {
      const rules = []
      if (protectedEnvironment)
        rules.push({
          type: 'required_reviewers',
          reviewers: [{ type: 'User', reviewer: { login: 'test' } }]
        })
      return json({ protection_rules: rules })
    }
    if (url.pathname === '/repos/test/repo/releases' && request.method === 'GET') {
      const releases = [...reservedReleases]
      if (release) releases.push(release)
      const page = Number(url.searchParams.get('page'))
      return json(releases.slice((page - 1) * 100, page * 100))
    }
    if (url.pathname === '/repos/test/repo/tags') {
      const page = Number(url.searchParams.get('page'))
      return json(tags.slice((page - 1) * 100, page * 100))
    }
    if (url.pathname.startsWith('/repos/test/repo/git/ref/tags/')) {
      const name = url.pathname.split('/').at(-1)
      if (tags.some((tag) => tag.name === name)) return json({ ref: `refs/tags/${name}` })
      return json({}, 404)
    }
    if (url.pathname === '/repos/test/repo/releases' && request.method === 'POST') {
      release = {
        id: 7,
        ...JSON.parse(body.toString()),
        assets: [],
        upload_url: `${origin}/upload{?name,label}`
      }
      return json(release, 201)
    }
    if (url.pathname === '/upload' && request.method === 'POST') {
      const name = url.searchParams.get('name')
      const item = {
        id: 11,
        name,
        state: 'uploaded',
        digest: `sha256:${createHash('sha256').update(body).digest('hex')}`
      }
      if (!Array.isArray(release?.assets)) throw new Error('missing release assets')
      release.assets.push(item)
      return json(item, 201)
    }
    if (url.pathname === '/repos/test/repo/releases/7' && request.method === 'GET')
      return json(release)
    if (url.pathname === '/repos/test/repo/releases/assets/11') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      return response.end(asset)
    }
    if (url.pathname === '/repos/test/repo/actions/runs/10/jobs') {
      const names = ['ubuntu-latest', 'macos-latest', 'windows-latest'].flatMap((os) =>
        ['24.15.0', 'node'].map((node) => `acceptance (${os}, ${node})`)
      )
      return json({
        jobs: names.map((name, index) => ({
          name,
          status: 'completed',
          conclusion: ['success', 'failure'][Number(index === failedCell)]
        }))
      })
    }
    if (url.pathname === '/repos/test/repo/releases/7' && request.method === 'PATCH') {
      const update = JSON.parse(body.toString())
      if (update.draft === false) {
        promotions++
        update.published_at = '2026-01-01T00:00:00Z'
      }
      Object.assign(release ?? {}, update)
      return json(release)
    }
    if (url.pathname === '/repos/test/repo/releases/7' && request.method === 'DELETE') {
      release = undefined
      response.writeHead(204)
      return response.end()
    }
    return json({ message: 'not found' }, 404)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server address')
  const origin = `http://127.0.0.1:${address.port}`
  function run(
    args: string[],
    authorized = true
  ): Promise<{ status: number | null; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/database-release.mjs', ...args], {
        env: {
          ...process.env,
          GITHUB_API_URL: origin,
          GITHUB_REPOSITORY: 'test/repo',
          GITHUB_TOKEN: 'isolated',
          GITHUB_RUN_ID: '10',
          DATABASE_RELEASE_AUTHORIZATION: ['', 'owner-authorized'][Number(authorized)]
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', (status) => resolve({ status, stdout }))
    })
  }
  try {
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
    expect((await run(['create', report, sqlite, ...files], false)).status).not.toBe(0)
    protectedEnvironment = false
    expect((await run(['create', report, sqlite, ...files])).status).not.toBe(0)
    protectedEnvironment = true
    writeFileSync(file, Buffer.from('corrupt asset'))
    expect((await run(['create', report, sqlite, ...files])).status).not.toBe(0)
    writeFileSync(file, asset)
    const validReport = readFileSync(report, 'utf8')
    writeFileSync(report, validReport.replace('"version":"1.0.0"', '"version":"1.0.1"'))
    expect((await run(['create', report, sqlite, ...files])).status).not.toBe(0)
    writeFileSync(report, validReport)
    expect(release).toBeUndefined()
    expect((await run(['create', report, sqlite, ...files])).status).toBe(0)
    expect(release?.draft).toBe(true)
    const download = path.join(dir, 'download.br')
    expect((await run(['download', '7', digest, download])).status).toBe(0)
    expect(readFileSync(download)).toEqual(asset)
    expect(
      (await run(['download', '7', `sha256:${'0'.repeat(64)}`, path.join(dir, 'bad.br')])).status
    ).not.toBe(0)
    async function checkFailedCell(index: number): Promise<void> {
      if (index === 6) return
      failedCell = index
      expect((await run(['promote', '7', 'db-v1.0.0', digest])).status).not.toBe(0)
      expect(promotions).toBe(0)
      await checkFailedCell(index + 1)
    }
    await checkFailedCell(0)
    failedCell = -1
    expect((await run(['promote', '7', 'db-v1.0.0', digest], false)).status).not.toBe(0)
    expect((await run(['promote', '7', 'db-v1.0.1', digest])).status).not.toBe(0)
    expect((await run(['promote', '7', 'db-v1.0.0', digest])).status).toBe(0)
    const published = { ...release }
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
    expect(release).toBeUndefined()
    async function checkReservedVersion(withdrawn: string): Promise<void> {
      release = { ...published }
      reservedReleases = []
      tags = [{ name: 'db-v1.0.0' }]
      if (withdrawn === 'deleted') {
        tags = Array.from({ length: 100 }, (_, index) => ({ name: `v0.0.${index}` }))
        tags.push({ name: 'db-v1.0.1' })
      } else {
        reservedReleases = Array.from({ length: 100 }, (_, index) => ({
          tag_name: `v0.0.${index}`,
          draft: true
        }))
        reservedReleases.push({
          tag_name: 'db-v1.0.1',
          draft: withdrawn === 'draft',
          prerelease: withdrawn === 'prerelease'
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
      expect(JSON.parse(readFileSync(report, 'utf8')).version).toBe('1.0.2')
      expect((await run(['create', report, candidate, ...files])).status).toBe(0)
      expect(release?.tag_name).toBe('db-v1.0.2')
    }
    await checkReservedVersion('prerelease')
    await checkReservedVersion('deleted')
    await checkReservedVersion('draft')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
