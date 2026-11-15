import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'

const api = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const digestPattern = /^sha256:[0-9a-f]{64}$/
const repository = process.env.GITHUB_REPOSITORY
const base = `${api}/repos/${repository}`
const token = process.env.GITHUB_TOKEN

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'wotlk-mcp-database-release'
}

const versionPattern = /^db-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const [command, ...args] = process.argv.slice(2)

if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token)
  throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required')

async function usedVersions(output) {
  const [releases, tags] = await Promise.all([list('releases'), list('tags')])
  const names = [...releases.map((release) => release.tag_name), ...tags.map((tag) => tag.name)]

  writeFileSync(
    output,
    JSON.stringify(names.filter((name) => versionPattern.test(name)).map((name) => name.slice(4)))
  )
}

async function list(endpoint, page = 1) {
  const items = await json(`${base}/${endpoint}?per_page=100&page=${page}`)

  if (!Array.isArray(items)) throw new Error(`invalid ${endpoint} list`)
  if (items.length < 100) return items

  return [...items, ...(await list(endpoint, page + 1))]
}

async function json(url, options) {
  return (await request(url, options)).json()
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } })

  if (!response.ok)
    throw new Error(`GitHub API ${options.method ?? 'GET'} ${response.status}: ${url}`)

  return response
}

async function authorize() {
  if (process.env.DATABASE_RELEASE_AUTHORIZATION !== 'owner-authorized')
    throw new Error('owner publication authorization is not provisioned')

  const environment = await json(`${base}/environments/database-publication`)
  const owner = repository.split('/')[0].toLowerCase()

  if (
    !environment.protection_rules?.some(
      (rule) =>
        rule.type === 'required_reviewers' &&
        rule.reviewers?.length === 1 &&
        rule.reviewers[0].type === 'User' &&
        rule.reviewers[0].reviewer?.login?.toLowerCase() === owner
    )
  )
    throw new Error(
      'database publication environment requires the repository owner as its sole reviewer'
    )
}

async function hashFile(file) {
  const hash = createHash('sha256')

  for await (const chunk of createReadStream(file)) hash.update(chunk)

  return `sha256:${hash.digest('hex')}`
}

function validRelease(release, id, tag, digest) {
  if (
    String(release.id) !== id ||
    !release.draft ||
    release.prerelease ||
    release.tag_name !== tag ||
    !versionPattern.test(tag)
  )
    throw new Error('draft identity or version mismatch')
  if (assetOf(release, 'wotlk.sqlite.br').digest !== digest)
    throw new Error('draft database digest changed')
}

function assetOf(release, name) {
  const matches =
    release.assets?.filter((item) => item.name === name && item.state === 'uploaded') ?? []

  if (matches.length !== 1 || !digestPattern.test(matches[0].digest ?? ''))
    throw new Error(`missing or invalid ${name} asset`)

  return matches[0]
}

async function previous(output) {
  const releases = await list('releases')
  const published = releases
    .filter(
      (release) => !release.draft && !release.prerelease && versionPattern.test(release.tag_name)
    )
    .toSorted((a, b) => String(b.published_at).localeCompare(String(a.published_at)))

  if (
    published.some(
      (release) =>
        typeof release.published_at !== 'string' ||
        !Number.isFinite(Date.parse(release.published_at))
    )
  )
    throw new Error('published database release lacks a valid publication date')

  if (published.length) {
    const asset = assetOf(published[0], 'wotlk.sqlite.br')
    const compressed = `${output}.br`

    try {
      await download(asset, compressed)
      await pipeline(
        createReadStream(compressed),
        createBrotliDecompress(),
        createWriteStream(output, { flags: 'wx' })
      )

      const db = new DatabaseSync(output, { readOnly: true })

      try {
        if (
          db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value !==
          published[0].tag_name.slice(4)
        )
          throw new Error('previous database schema version does not match release')
      } finally {
        db.close()
      }
    } finally {
      rmSync(compressed, { force: true })
    }

    return published[0].tag_name
  }

  return undefined
}

async function download(asset, output) {
  const response = await request(`${base}/releases/assets/${asset.id}`, {
    headers: { Accept: 'application/octet-stream' }
  })

  if (!response.body) throw new Error('empty asset response')

  const temporary = `${output}.${process.pid}.partial`
  const hash = createHash('sha256')

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk)
          callback(undefined, chunk)
        }
      }),
      createWriteStream(temporary, { flags: 'wx' })
    )

    if (`sha256:${hash.digest('hex')}` !== asset.digest) throw new Error('asset digest mismatch')

    renameSync(temporary, output)
  } finally {
    rmSync(temporary, { force: true })
  }
}

if (command === 'previous') {
  const [output, versions] = args

  if (!output || args.length > 2) throw new Error('usage: previous OUTPUT.sqlite [VERSIONS.json]')

  if (versions) await usedVersions(versions)

  const tag = await previous(output)

  if (tag) console.log(tag)
} else if (command === 'create') {
  await authorize()

  const [report, database, ...files] = args

  if (!report || !database || !files.length)
    throw new Error('usage: create GATE.json CANDIDATE.sqlite ASSET...')

  const gate = JSON.parse(readFileSync(report, 'utf8'))
  const tag = `db-v${gate.version}`

  if (
    !versionPattern.test(tag) ||
    new Set(files.map((file) => path.basename(file))).size !== files.length
  )
    throw new Error('invalid version or duplicate asset names')

  for (const name of [
    'wotlk.sqlite.br',
    'NOTICE.md',
    'fidelity.json',
    'build-report.json',
    'gate.json'
  ])
    if (!files.some((file) => path.basename(file) === name))
      throw new Error(`missing release asset: ${name}`)

  const releases = await list('releases')

  if (releases.some((release) => release.tag_name === tag))
    throw new Error('release tag already exists')

  const ref = await fetch(`${base}/git/ref/tags/${tag}`, { headers })

  if (ref.status !== 404) throw new Error('tag exists or cannot be checked')

  const temporary = mkdtempSync(path.join(tmpdir(), 'wotlk-release-gate-'))

  try {
    const old = path.join(temporary, 'previous.sqlite')
    const oldTag = await previous(old)
    const versions = path.join(temporary, 'versions.json')

    await usedVersions(versions)

    const asset = files.find((file) => path.basename(file) === 'wotlk.sqlite.br')
    const argumentsForGate = [
      'scripts/release-gate.ts',
      database,
      asset,
      `--used-versions=${versions}`
    ]

    if (oldTag) argumentsForGate.push(old)

    if (gate.allow_shrink === true) argumentsForGate.push('--allow-shrink')

    const checked = JSON.parse(execFileSync('vpx', argumentsForGate, { encoding: 'utf8' }))

    if (JSON.stringify(checked) !== JSON.stringify(gate))
      throw new Error('gate report does not match candidate and previous release')

    const uploadedReport = files.find((file) => path.basename(file) === 'gate.json')

    if (readFileSync(uploadedReport, 'utf8') !== readFileSync(report, 'utf8'))
      throw new Error('gate report asset mismatch')
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }

  const body = readFileSync(report, 'utf8')
  const notice = readFileSync(
    files.find((file) => path.basename(file) === 'NOTICE.md'),
    'utf8'
  )
  const release = await json(`${base}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: process.env.GITHUB_SHA,
      name: tag,
      body: `Database gate report:\n\n\`\`\`json\n${body}\n\`\`\`\n\n${notice}`,
      draft: true,
      prerelease: false
    })
  })

  if (!release.draft || release.tag_name !== tag || !Number.isSafeInteger(release.id))
    throw new Error('invalid created draft')

  await Promise.all(
    files.map(async (file) => {
      const uploadUrl = new URL(release.upload_url.replace(/\{.*$/, ''))

      uploadUrl.searchParams.set('name', path.basename(file))

      const uploaded = await json(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(statSync(file).size)
        },
        body: createReadStream(file),
        duplex: 'half'
      })

      if (uploaded.digest !== (await hashFile(file)) || uploaded.state !== 'uploaded')
        throw new Error(`uploaded digest mismatch: ${file}`)
    })
  )

  const saved = await json(`${base}/releases/${release.id}`)
  const asset = assetOf(saved, 'wotlk.sqlite.br')

  validRelease(saved, String(release.id), tag, asset.digest)
  console.log(JSON.stringify({ id: release.id, tag, digest: asset.digest }))
} else if (command === 'download') {
  const [id, digest, output] = args

  if (!/^\d+$/.test(id ?? '') || !digestPattern.test(digest ?? '') || !output || args.length !== 3)
    throw new Error('usage: download ID DIGEST OUTPUT.br')

  const release = await json(`${base}/releases/${id}`)

  validRelease(release, id, release.tag_name, digest)
  await download(assetOf(release, 'wotlk.sqlite.br'), output)
} else if (command === 'promote') {
  await authorize()

  const [id, tag, digest] = args
  const runId = process.env.GITHUB_RUN_ID

  if (
    !/^\d+$/.test(id ?? '') ||
    !/^\d+$/.test(runId ?? '') ||
    !digestPattern.test(digest ?? '') ||
    args.length !== 3
  )
    throw new Error('usage: promote ID TAG DIGEST')

  const release = await json(`${base}/releases/${id}`)

  validRelease(release, id, tag, digest)

  const releases = await list('releases')

  if (releases.some((item) => item.tag_name === tag && String(item.id) !== id))
    throw new Error('conflicting release tag')

  const { jobs } = await json(`${base}/actions/runs/${runId}/jobs?per_page=100`)

  if (!Array.isArray(jobs)) throw new Error('invalid matrix jobs')

  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest'])
    for (const node of ['24.15.0', 'node']) {
      const matches = jobs.filter((job) => job.name === `acceptance (${os}, ${node})`)

      if (
        matches.length !== 1 ||
        matches[0].status !== 'completed' ||
        matches[0].conclusion !== 'success'
      )
        throw new Error(`acceptance matrix failed: ${os} ${node}`)
    }

  const result = await json(`${base}/releases/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: false, prerelease: false, make_latest: 'false' })
  })

  if (result.draft || result.tag_name !== tag) throw new Error('promotion result mismatch')

  console.log(tag)
} else if (command === 'rollback') {
  await authorize()

  const [id, tag, operation] = args

  if (
    !/^\d+$/.test(id ?? '') ||
    !versionPattern.test(tag ?? '') ||
    !['prerelease', 'delete'].includes(operation) ||
    args.length !== 3
  )
    throw new Error('usage: rollback ID TAG prerelease|delete')

  const release = await json(`${base}/releases/${id}`)

  if (String(release.id) !== id || release.tag_name !== tag || release.draft)
    throw new Error('published release identity mismatch')

  if (operation === 'delete') await request(`${base}/releases/${id}`, { method: 'DELETE' })
  else {
    const updated = await json(`${base}/releases/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prerelease: true })
    })

    if (!updated.prerelease || updated.tag_name !== tag || updated.draft)
      throw new Error('rollback result mismatch')
  }

  console.log(`${tag}: ${operation}`)
} else throw new Error('usage: database-release.mjs previous|create|download|promote|rollback ...')
