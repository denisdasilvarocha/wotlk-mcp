import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'
import { z } from 'zod'

const wowRevision = 'a'.repeat(40)
const worldRevision = 'b'.repeat(40)
const codexRevision = 'c'.repeat(40)
const digest = 'd'.repeat(64)

function lastJsonLine(output: string): unknown {
  return JSON.parse(output.trim().split('\n').at(-1) ?? '')
}

function run(output: string, bin: string, umask?: number): SpawnSyncReturns<string> {
  if (!existsSync(path.join(bin, 'fetch.mjs'))) {
    writeFileSync(path.join(bin, 'fetch.mjs'), '')
  }

  return spawnSync(
    process.execPath,
    [
      '--import',
      path.join(bin, 'fetch.mjs'),
      '--input-type=module',
      '-e',
      `import { acquireSources } from ${JSON.stringify(new URL('../../build/sources/index.ts', import.meta.url).href)}; ${umask === undefined ? '' : `process.umask(${umask});`} console.log(JSON.stringify(await acquireSources(process.argv[1])))`,
      output
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
    }
  )
}

function fixtures(
  dir: string,
  options: Readonly<{
    badProvenance?: boolean
    mismatch?: boolean
    failedDownload?: boolean
    token?: 'GITHUB_TOKEN' | 'GH_TOKEN'
  }> = {}
): void {
  let archiveResponse = "'archive bytes'"
  let checkoutRevision = codexRevision
  let provenance: object = {
    SLSA: {
      buildDefinition: {
        externalParameters: {
          request: {
            root: {
              request: {
                args: {
                  'vcs:revision': worldRevision,
                  'vcs:source': 'https://github.com/azerothcore/azerothcore-wotlk'
                }
              }
            }
          }
        }
      }
    }
  }

  if (options.failedDownload === true) {
    archiveResponse = 'null, { status: 503 }'
  }

  if (options.mismatch === true) {
    checkoutRevision = 'e'.repeat(40)
  }

  if (options.badProvenance === true) {
    provenance = {}
  }
  writeFileSync(
    path.join(dir, 'fetch.mjs'),
    `
    process.env.GITHUB_TOKEN = ''
    process.env.GH_TOKEN = ''
    ${options.token ? `process.env.${options.token} = 'source-token'` : ''}
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const authorization = new Headers(init?.headers).get('Authorization')
      if (url.startsWith('https://api.github.com/') && ${Boolean(options.token)} && authorization !== 'Bearer source-token') {
        return new Response(null, { status: 403 })
      }
      if (url.startsWith('https://codeload.github.com/') && authorization !== null) {
        throw new Error('Credentials leaked to archive host')
      }
      if (url.includes('WoWDBDefs/commits/')) return Response.json({ sha: '${wowRevision}' })
      if (url.includes('milkyway-codex/commits/')) return Response.json({ sha: '${codexRevision}' })
      if (url.includes('codeload.github.com/')) return new Response(${archiveResponse})
      throw new Error('Unexpected URL: ' + url)
    }
  `
  )
  executable(
    dir,
    'gh',
    'for last do :; done\nprintf bundle > "$last/client-inputs-12340-engb-1.tar.gz"'
  )
  executable(dir, 'python3', 'exit 0')
  executable(dir, 'tar', 'exit 0')
  executable(dir, 'curl', 'exit 1')
  executable(
    dir,
    'docker',
    `case "$*" in
    *"acore/ac-wotlk-db-import@sha256:${digest}"*Provenance*) printf '%s' '${JSON.stringify(provenance)}' ;;
    *Provenance*) exit 1 ;;
    *) printf '%s' '{"digest":"sha256:${digest}","manifests":[{"platform":{"os":"linux","architecture":"amd64"}}]}' ;;
  esac`
  )
  executable(
    dir,
    'git',
    `case "$*" in
    *"init -q"*) mkdir -p "$3/.git" "$3/src/data"; for name in api-functions events widgets cvars data-types combat-log-events secure-templates book-chapters; do printf '%s' "$name" > "$3/src/data/$name.ts"; done ;;
    *"rev-parse HEAD"*) printf '%s' '${checkoutRevision}' ;;
  esac`
  )
}

function executable(dir: string, name: string, body: string): void {
  const file = path.join(dir, name)

  writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`)
  chmodSync(file, 0o755)
}

test('does not overwrite an existing input directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'reference-inputs-test-'))

  try {
    const output = path.join(dir, 'inputs')

    mkdirSync(output)
    writeFileSync(path.join(output, 'keep'), 'existing')

    const result = run(output, dir)

    expect(result.status).not.toBe(0)
    expect(readFileSync(path.join(output, 'keep'), 'utf8')).toBe('existing')
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('rejects a corrupt private release before extraction and removes partial inputs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'reference-inputs-test-'))

  try {
    const output = path.join(dir, 'inputs')

    executable(
      dir,
      'gh',
      'for last do :; done\nprintf corrupt > "$last/client-inputs-12340-engb-1.tar.gz"'
    )
    executable(dir, 'tar', `echo extracted > '${dir}/extracted'; exit 1`)

    const result = run(output, dir)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('bundle SHA-256 mismatch')
    expect(existsSync(path.join(dir, 'extracted'))).toBe(false)
    expect(existsSync(output)).toBe(false)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test.each([undefined, 'GITHUB_TOKEN', 'GH_TOKEN'] as const)(
  'returns immutable source identities and acquired file hashes with token %s',
  (token) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'reference-inputs-test-'))

    try {
      fixtures(dir, { token })

      const result = run(path.join(dir, 'inputs'), dir)

      expect(result.status).toBe(0)

      const sources = z
        .object({
          azerothcore: z.object({ directory: z.string(), revision: z.string() }),
          codex: z.object({
            files: z.record(z.string(), z.unknown()),
            revision: z.string(),
            sha256: z.string()
          }),
          codexNodeImage: z.string(),
          worldImporterImage: z.string(),
          wowdbdefs: z.object({ revision: z.string(), sha256: z.string() })
        })
        .parse(lastJsonLine(result.stdout))

      expect(sources.wowdbdefs.revision).toBe(wowRevision)
      expect(sources.azerothcore.revision).toBe(worldRevision)
      expect(sources.codex.revision).toBe(codexRevision)
      expect(sources.worldImporterImage).toBe(`acore/ac-wotlk-db-import@sha256:${digest}`)
      expect(sources.codexNodeImage).toBe(`node@sha256:${digest}`)
      expect(sources.wowdbdefs.sha256).toBe(
        'cc9c340301ad4ba5e54aa24b442ff938d1ed84f7f32c4c5a73773c58af37bd1b'
      )
      expect(sources.codex.sha256).toBe(
        '7c45cdb5f1843f9166f13cce1ab0840dccb83571934732b17c71f19d683a3e8b'
      )
      expect(Object.keys(sources.codex.files)).toHaveLength(8)
      // The world importer container runs as another user and must traverse the source.
      expect(statSync(sources.azerothcore.directory).mode & 0o005).toBe(0o005)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  }
)

test('makes public mount content readable under umask 077 without opening private paths', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'reference-inputs-test-'))
  const output = path.join(dir, 'inputs')

  try {
    fixtures(dir)
    executable(
      dir,
      'tar',
      `case "$*" in
    *azerothcore.tar.gz*) mkdir "$4/data"; printf sql > "$4/data/world.sql"; ln -s ../client-inputs "$4/client-link" ;;
  esac`
    )

    const result = run(output, dir, 0o077)

    expect(result.status).toBe(0)
    expect(statSync(path.join(output, 'azerothcore')).mode & 0o777).toBe(0o755)
    expect(statSync(path.join(output, 'azerothcore/data')).mode & 0o777).toBe(0o755)
    expect(statSync(path.join(output, 'azerothcore/data/world.sql')).mode & 0o777).toBe(0o644)
    expect(statSync(path.join(output, 'codex')).mode & 0o777).toBe(0o755)
    expect(statSync(path.join(output, 'codex/src/data')).mode & 0o777).toBe(0o755)
    expect(statSync(path.join(output, 'codex/src/data/widgets.ts')).mode & 0o777).toBe(0o644)
    expect(statSync(path.join(output, 'codex/.git')).mode & 0o777).toBe(0o700)
    expect(statSync(path.join(output, 'client-inputs')).mode & 0o777).toBe(0o700)
    expect(statSync(output).mode & 0o777).toBe(0o700)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test.each([
  ['malformed provenance', { badProvenance: true }],
  ['checkout mismatch', { mismatch: true }],
  ['failed archive download', { failedDownload: true }]
])(
  'rejects %s and removes owned inputs',
  (
    _name,
    options: Readonly<{ badProvenance?: boolean; mismatch?: boolean; failedDownload?: boolean }>
  ) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'reference-inputs-test-'))

    try {
      fixtures(dir, options)

      const output = path.join(dir, 'inputs')
      const result = run(output, dir)

      expect(result.status).not.toBe(0)
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  }
)
