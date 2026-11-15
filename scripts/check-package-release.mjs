import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'

import { acceptedSchemaMajor } from '../src/schema.ts'

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'wotlk-mcp-release' }
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

const [
  tag,
  releasesUrl = 'https://api.github.com/repos/denisdasilvarocha/wotlk-mcp/releases',
  registryUrl = 'https://registry.npmjs.org/wotlk-mcp'
] = process.argv.slice(2)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const version = semver.exec(pkg.version)

if (!version || tag !== `v${pkg.version}`)
  throw new Error('package version and v<semver> tag must match')

if (!Number.isSafeInteger(pkg.wotlkSchemaMajor) || pkg.wotlkSchemaMajor < 1)
  throw new Error('invalid accepted schema major')

if (pkg.wotlkSchemaMajor !== acceptedSchemaMajor)
  throw new Error('package metadata does not match accepted schema major')

if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
const registry = await fetch(registryUrl)

if (registry.status === 404)
  throw new Error(
    'npm package does not exist; owner must provision it and configure the trusted publisher before release (see docs/releases.md)'
  )

if (!registry.ok) throw new Error(`npm registry lookup failed: ${registry.status}`)

if (registry.ok) {
  const metadata = await registry.json()

  if (!metadata.versions || typeof metadata.versions !== 'object')
    throw new Error('invalid npm registry metadata')

  for (const [publishedVersion, published] of Object.entries(metadata.versions)) {
    const parsed = semver.exec(publishedVersion)

    if (!parsed) continue
    if (publishedVersion === pkg.version) throw new Error('package version already published')
    if (parsed[1] === version[1] && published.wotlkSchemaMajor !== pkg.wotlkSchemaMajor)
      throw new Error('schema major changed without a package-major change')
  }
}

async function checkReleasePage(page) {
  const url = new URL(releasesUrl)

  url.searchParams.set('per_page', '100')
  url.searchParams.set('page', String(page))

  const response = await fetch(url, { headers })

  if (!response.ok) throw new Error(`database release lookup failed: ${response.status}`)

  const releases = await response.json()

  if (!Array.isArray(releases)) throw new Error('invalid database releases response')

  const release = releases.find((item) => {
    const match = /^db-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(item.tag_name)

    return match && Number(match[1]) === pkg.wotlkSchemaMajor && !item.draft && !item.prerelease
  })

  if (!release) {
    if (releases.length === 100) return checkReleasePage(page + 1)

    throw new Error(`no published compatible database for schema major ${pkg.wotlkSchemaMajor}`)
  }

  const asset = release.assets?.find((item) => item.name === 'wotlk.sqlite.br')

  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ''))
    throw new Error('published database asset or digest missing')

  const download = await fetch(asset.url, {
    headers: { ...headers, Accept: 'application/octet-stream' }
  })

  if (!download.ok || !download.body)
    throw new Error(`database download failed: ${download.status}`)

  const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-release-'))

  try {
    const compressed = path.join(directory, 'reference.br')
    const database = path.join(directory, 'reference.sqlite')
    const hash = createHash('sha256')
    const hashing = new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk)
        callback(undefined, chunk)
      }
    })

    await pipeline(Readable.fromWeb(download.body), hashing, createWriteStream(compressed))

    if (`sha256:${hash.digest('hex')}` !== asset.digest)
      throw new Error('database asset digest mismatch')

    await pipeline(
      createReadStream(compressed),
      createBrotliDecompress(),
      createWriteStream(database)
    )

    const db = new DatabaseSync(database, { readOnly: true })

    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()

      if (
        typeof row?.value !== 'string' ||
        !new RegExp(`^${pkg.wotlkSchemaMajor}\\.\\d+\\.\\d+$`).test(row.value)
      )
        throw new Error('published database schema does not match package')
    } finally {
      db.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

await checkReleasePage(1)
console.log(`Package ${tag} has a published compatible schema ${pkg.wotlkSchemaMajor} database`)
