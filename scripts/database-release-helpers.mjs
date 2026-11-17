import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, renameSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'

import { ownerApproved, readRelease, readTag } from './database-release-readers.mjs'
import { asArray } from './records.mjs'

const api = process.env.GITHUB_API_URL ?? 'https://api.github.com'
export const digestPattern = /^sha256:[0-9a-f]{64}$/u
const repository = process.env.GITHUB_REPOSITORY
export const base = `${api}/repos/${repository}`
const token = process.env.GITHUB_TOKEN
export const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'wotlk-mcp-database-release',
  'X-GitHub-Api-Version': '2022-11-28'
}
export const versionPattern = /^db-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

/** @typedef {{ readonly id: number, readonly name: string, readonly state: string, readonly digest: string }} Asset */
/** @typedef {{ readonly id: number, readonly tag_name: string, readonly draft: boolean, readonly prerelease: boolean, readonly published_at: string | null, readonly upload_url: string, readonly assets?: readonly Asset[] }} Release */
/** @typedef {{ readonly name: string }} Tag */
/** @typedef {Readonly<{ body?: string | (() => ReadableStream), duplex?: 'half', headers?: Readonly<Record<string, string>>, method?: string }>} RequestOptions */

export {
  assetOf,
  authorize,
  download,
  hashFile,
  json,
  list,
  previous,
  request,
  usedVersions,
  validRelease
}

/** @param {string} output - Output path. */
async function usedVersions(output) {
  const [releases, tags] = await Promise.all([list('releases'), list('tags')])
  const names = [...releases.map((release) => release.tag_name), ...tags.map((tag) => tag.name)]

  writeFileSync(
    output,
    JSON.stringify(names.filter((name) => versionPattern.test(name)).map((name) => name.slice(4)))
  )
}

/**
 * @overload
 * @param {'releases'} endpoint - API endpoint.
 * @param {number} [page] - Page number.
 * @returns {Promise<Release[]>} Release list.
 */
/**
 * @overload
 * @param {'tags'} endpoint - API endpoint.
 * @param {number} [page] - Page number.
 * @returns {Promise<Tag[]>} Tag list.
 */
/**
 * @param {'releases' | 'tags'} endpoint - API endpoint.
 * @param {number} [page] - Page number.
 * @returns {Promise<(Release | Tag)[]>} API items.
 */
async function list(endpoint, page = 1) {
  const values = asArray(await json(`${base}/${endpoint}?per_page=100&page=${page}`))
  const items =
    endpoint === 'releases'
      ? values.map((value) => readRelease(value))
      : values.map((value) => readTag(value))
  if (items.length < 100) {
    return items
  }
  return [...items, ...(await listPage(endpoint, page + 1))]
}

/**
 * @param {'releases' | 'tags'} endpoint - API endpoint.
 * @param {number} page - Page number.
 * @returns {Promise<(Release | Tag)[]>} API items.
 */
function listPage(endpoint, page) {
  return endpoint === 'releases' ? list('releases', page) : list('tags', page)
}

/**
 * @param {string} url - API URL.
 * @param {RequestOptions} [options] - Request options.
 * @returns {Promise<unknown>} Parsed response.
 */
async function json(url, options) {
  return (await request(url, options)).json()
}

/**
 * @param {string} url - API URL.
 * @param {RequestOptions} [options] - Request options.
 * @returns {Promise<Response>} API response.
 */
async function request(url, options = {}) {
  const body = typeof options.body === 'function' ? options.body() : options.body
  const response = await fetch(url, {
    ...options,
    body,
    headers: { ...headers, ...options.headers }
  })

  if (!response.ok) {
    throw new Error(`GitHub API ${options.method ?? 'GET'} ${response.status}: ${url}`)
  }

  return response
}

async function authorize() {
  if (process.env.DATABASE_RELEASE_AUTHORIZATION !== 'owner-authorized') {
    throw new Error('owner publication authorization is not provisioned')
  }

  const environment = await json(`${base}/environments/database-publication`)
  const owner = (repository ?? '').split('/')[0].toLowerCase()

  if (!ownerApproved(environment, owner)) {
    throw new Error(
      'database publication environment requires the repository owner as its sole reviewer'
    )
  }
}

/**
 * @param {string} file - File path.
 * @returns {Promise<string>} SHA-256 digest.
 */
async function hashFile(file) {
  const hash = createHash('sha256')

  for await (const chunk of createReadStream(file)) {
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
      throw new TypeError('invalid file chunk')
    }
    hash.update(chunk)
  }

  return `sha256:${hash.digest('hex')}`
}

/**
 * @param {Release} release - Release to validate.
 * @param {string} id - Expected identifier.
 * @param {string} tag - Expected tag.
 * @param {string} digest - Expected digest.
 */
function validRelease(release, id, tag, digest) {
  if (
    String(release.id) !== id ||
    !release.draft ||
    release.prerelease ||
    release.tag_name !== tag ||
    !versionPattern.test(tag)
  ) {
    throw new Error('draft identity or version mismatch')
  }
  if (assetOf(release, 'wotlk.sqlite.br').digest !== digest) {
    throw new Error('draft database digest changed')
  }
}

/**
 * @param {Release} release - Release containing the asset.
 * @param {string} name - Asset name.
 * @returns {Asset} Matching asset.
 */
function assetOf(release, name) {
  const matches =
    release.assets?.filter((item) => item.name === name && item.state === 'uploaded') ?? []

  if (matches.length !== 1 || !digestPattern.test(matches[0].digest ?? '')) {
    throw new Error(`missing or invalid ${name} asset`)
  }

  return matches[0]
}

/**
 * @param {string} output - Output path.
 * @returns {Promise<string | undefined>} Previous tag, if present.
 */
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
  ) {
    throw new Error('published database release lacks a valid publication date')
  }

  if (published.length > 0) {
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
        ) {
          throw new Error('previous database schema version does not match release')
        }
      } finally {
        db.close()
      }
    } finally {
      rmSync(compressed, { force: true })
    }
  }

  return published[0]?.tag_name
}

/**
 * @param {Asset} asset - Asset to download.
 * @param {string} output - Output path.
 */
async function download(asset, output) {
  const response = await request(`${base}/releases/assets/${asset.id}`, {
    headers: { Accept: 'application/octet-stream' }
  })

  if (!response.body) {
    throw new Error('empty asset response')
  }

  const temporary = `${output}.${process.pid}.partial`
  const hash = createHash('sha256')

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
            callback(new TypeError('invalid asset chunk'))
            return
          }
          hash.update(chunk)
          callback(undefined, chunk)
        }
      }),
      createWriteStream(temporary, { flags: 'wx' })
    )

    if (`sha256:${hash.digest('hex')}` !== asset.digest) {
      throw new Error('asset digest mismatch')
    }

    renameSync(temporary, output)
  } finally {
    rmSync(temporary, { force: true })
  }
}

if (
  repository === undefined ||
  repository === '' ||
  !/^[\w.-]+\/[\w.-]+$/u.test(repository) ||
  token === undefined ||
  token === ''
) {
  throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required')
}
