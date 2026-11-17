import { acceptedSchemaMajor } from '../schema.js'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'
import * as z from 'zod'

const headers: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wotlk-mcp'
}
const releasesUrl = 'https://api.github.com/repos/denisdasilvarocha/wotlk-mcp/releases?per_page=100'
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
if (token !== undefined && token !== '') {
  headers.Authorization = `Bearer ${token}`
}

const releasesSchema = z.array(
  z.object({
    assets: z.array(z.object({ digest: z.string().nullish(), name: z.string(), url: z.string() })),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullish(),
    tag_name: z.string()
  })
)
type DeepReadonly<T> = T extends (...args: readonly never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T
type Release = DeepReadonly<z.infer<typeof releasesSchema>[number]>
type Candidate = { readonly release: Release; readonly version: readonly number[] }

async function releasePages(url: string): Promise<z.infer<typeof releasesSchema>> {
  const response = await fetch(url, { headers })

  if (!response.ok) {
    throw new Error(`GitHub releases request returned HTTP ${response.status}`)
  }

  const page = releasesSchema.parse(await response.json())
  const next = response.headers
    .get('link')
    ?.split(',')
    .map((part) => part.trim())
    .find((part) => /;\s*rel="next"/u.test(part))
    ?.match(/^<([^>]+)>/u)?.[1]

  if (next !== undefined && next !== '') {
    page.push(...(await releasePages(next)))
  }

  return page
}

export async function selectRelease(
  setWarning: (value: number | undefined) => void
): Promise<Candidate> {
  const releases = await releasePages(releasesUrl)
  const candidates = releases
    .flatMap((release: Release) => {
      const match = /^db-v(\d+)\.(\d+)\.(\d+)$/u.exec(release.tag_name)

      if (!match || release.draft || release.prerelease) {
        return []
      }

      return [{ release, version: match.slice(1).map(Number) }]
    })
    .toSorted((a: Candidate, b: Candidate) =>
      (b.release.published_at ?? '').localeCompare(a.release.published_at ?? '')
    )
  const selected = candidates.find(({ version }: Candidate) => version[0] === acceptedSchemaMajor)
  const higher = candidates.find(({ version }: Candidate) => version[0] > acceptedSchemaMajor)

  setWarning(higher?.version[0])

  if (higher) {
    console.error(`newer reference data needs wotlk-mcp@${higher.version[0]}; update your config`)
  }

  if (!selected) {
    if (higher) {
      throw new Error(
        `no compatible release; newer reference data needs wotlk-mcp@${higher.version[0]}`
      )
    }

    throw new Error('no compatible published reference release')
  }
  return selected
}

export async function transferAsset(
  url: string,
  digest: string,
  compressed: string,
  partial: string,
  setTotal: (value: number) => void,
  addReceived: (value: number) => void
): Promise<void> {
  // browser_download_url 404s for private repositories even with a token.
  const response = await fetch(url, {
    headers: { ...headers, Accept: 'application/octet-stream' }
  })
  if (!response.ok || !response.body) {
    throw new Error(`database download returned HTTP ${response.status}`)
  }
  const length = Number(response.headers.get('content-length'))
  if (Number.isSafeInteger(length) && length > 0) {
    setTotal(length)
  }
  const hash = createHash('sha256')
  const progress = new Transform({
    transform(chunk: DeepReadonly<Buffer>, _encoding, callback): void {
      addReceived(chunk.length)
      hash.update(chunk)
      callback(undefined, chunk)
    }
  })
  await pipeline(
    Readable.fromWeb(response.body),
    progress,
    createWriteStream(compressed, { flags: 'wx' })
  )
  if (`sha256:${hash.digest('hex')}` !== digest.toLowerCase()) {
    throw new Error('database SHA-256 digest mismatch')
  }
  await pipeline(
    createReadStream(compressed),
    createBrotliDecompress(),
    createWriteStream(partial, { flags: 'wx' })
  )
}
