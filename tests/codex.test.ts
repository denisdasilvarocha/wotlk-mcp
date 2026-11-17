import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { expect, test } from 'vite-plus/test'

import { importCodex, readCodex } from '../build/codex.ts'
import { initReference } from '../build/offsets.ts'
import type { CodexSource } from '../build/sources.ts'
import { packagedServer, unpackPackage } from './package.ts'

async function waitForStart(started: string, getExitCode: () => number | null): Promise<void> {
  for (let i = 0; i < 40 && !existsSync(started) && getExitCode() === null; i++) {
    // eslint-disable-next-line no-await-in-loop -- Wait for the child to install its signal handler.
    await delay(50)
  }
}

function killStarted(started: string): void {
  if (existsSync(started)) {
    try {
      process.kill(Number(readFileSync(started, 'utf8')), 'SIGKILL')
    } catch {}
  }
}

function writeFixture(dir: string): CodexSource {
  const files: Record<string, string> = {}
  const aggregate = createHash('sha256')

  mkdirSync(path.join(dir, 'src/data'), { recursive: true })

  for (const name of [
    'api-functions',
    'events',
    'widgets',
    'cvars',
    'data-types',
    'combat-log-events',
    'secure-templates',
    'book-chapters'
  ]) {
    const file = `src/data/${name}.ts`
    const bytes = `export const fixture = ${JSON.stringify(name)}`

    writeFileSync(path.join(dir, file), bytes)
    files[file] = createHash('sha256').update(bytes).digest('hex')
    aggregate.update(file).update('\0').update(bytes)
  }

  return { directory: dir, files, revision: 'fixture', sha256: aggregate.digest('hex') }
}

test('Codex importer preserves source details and rejects altered inputs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-'))

  try {
    const source = writeFixture(dir)
    const dbPath = path.join(dir, 'reference.sqlite')

    initReference(dbPath)

    const bin = path.join(dir, 'bin')
    const log = path.join(dir, 'docker.log')

    mkdirSync(bin)
    writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh
echo "$1" >> '${log}'
if [ "$1" = run ]; then echo 'evaluation failed' >&2; exit 1; fi
`
    )
    chmodSync(path.join(bin, 'docker'), 0o755)

    const originalPath = process.env.PATH

    process.env.PATH = `${bin}${path.delimiter}${originalPath}`

    try {
      await expect(readCodex(source, 'node@sha256:fixture')).rejects.toThrow('evaluation failed')
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['run', 'rm'])
    } finally {
      process.env.PATH = originalPath
    }

    importCodex(dbPath, source, {
      API_FUNCTIONS: [
        {
          category: 'Demo',
          description: 'Does foo',
          memoryAddress: '0x1234',
          name: 'Foo',
          parameters: [{ name: 'x' }],
          returns: [{ name: 'y' }]
        }
      ],
      CHAPTER_PAGES: { 1: 45 },
      COMBAT_LOG_PREFIXES: [{ arguments: [{ name: 'spellId' }], name: 'SPELL' }],
      COMBAT_LOG_SUB_EVENTS: [
        {
          arguments: [{ name: 'amount' }],
          description: 'Damage',
          name: 'SPELL_DAMAGE',
          prefixes: ['SPELL']
        }
      ],
      CVARS: [{ category: 'General', defaultValue: '1', description: '', name: 'testCVar' }],
      DATA_TYPES: [{ description: 'Anchors', name: 'anchorPoint', values: [{ name: 'CENTER' }] }],
      EVENTS: [{ category: 'Demo', description: 'Event', name: 'EVENT', parameters: [] }],
      SECURE_TEMPLATES: [
        {
          attributes: [{ name: 'type' }],
          description: 'Secure',
          examples: [],
          name: 'SecureActionButtonTemplate'
        }
      ],
      WIDGETS: [
        {
          description: 'Widget',
          inheritedMethods: [],
          methods: [
            {
              description: 'Anchors',
              name: 'Region:SetPoint(point)',
              parameters: [{ name: 'point' }],
              returns: [],
              signature: 'Region:SetPoint(point)'
            }
          ],
          name: 'Region',
          scriptHandlers: [{ name: 'OnShow' }]
        }
      ]
    })

    const db = new DatabaseSync(dbPath, { readOnly: true })

    try {
      expect(
        db.prepare("SELECT hint, search_text FROM record WHERE id='fn:Foo'").get()
      ).toMatchObject({
        hint: 'Demo',
        search_text: 'Does foo'
      })
      expect(db.prepare('SELECT parameters, memoryAddress FROM lua_fn').get()).toMatchObject({
        memoryAddress: '0x1234',
        parameters: '[{"name":"x"}]'
      })
      expect(
        db.prepare("SELECT name FROM record WHERE id='method:Region:SetPoint'").get()
      ).toMatchObject({ name: 'SetPoint' })
      expect(db.prepare('SELECT methods, scriptHandlers FROM lua_widget').get()).toMatchObject({
        methods: '["SetPoint"]',
        scriptHandlers: '[{"name":"OnShow"}]'
      })
      expect(db.prepare('SELECT arguments FROM lua_cle').get()).toMatchObject({
        arguments: '[{"name":"spellId"},{"name":"amount"}]'
      })
      expect(db.prepare('SELECT count(*) AS n FROM link').get()).toMatchObject({ n: 0 })
      expect(db.prepare("SELECT sha256 FROM source WHERE name = 'codex'").get()).toMatchObject({
        sha256: source.sha256
      })
    } finally {
      db.close()
    }

    unpackPackage(dir)

    const client = new Client({ name: 'codex-test', version: '1' })

    try {
      await client.connect(packagedServer(dir, dbPath))

      const result = await client.callTool({
        arguments: { ids: ['fn:Foo', 'method:Region:SetPoint', 'widget:Region'] },
        name: 'get'
      })

      expect(JSON.stringify(result)).toContain('memoryAddress: 0x1234')
      expect(JSON.stringify(result)).toContain('declaringWidget: Region')
      expect(JSON.stringify(result)).toContain('OnShow')
    } finally {
      await client.close()
    }

    writeFileSync(path.join(dir, 'src/data/cvars.ts'), 'corrupted')
    await expect(readCodex(source, '')).rejects.toThrow('Codex SHA-256 mismatch')
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('Codex cancellation removes the container before exit even if Docker ignores SIGTERM', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-cancel-'))
  const bin = path.join(dir, 'bin')
  const started = path.join(dir, 'started')
  const cleaned = path.join(dir, 'cleaned')

  mkdirSync(bin)
  const source = writeFixture(dir)

  writeFileSync(
    path.join(bin, 'docker'),
    `#!${process.execPath}
const fs = require('node:fs')
if (process.argv[2] === 'run') {
  process.on('SIGTERM', () => {})
  fs.writeFileSync(${JSON.stringify(started)}, String(process.pid))
  setInterval(() => {}, 1000)
} else {
  fs.writeFileSync(${JSON.stringify(cleaned)}, '')
}
`
  )
  chmodSync(path.join(bin, 'docker'), 0o755)

  const script = `import { readCodex } from ${JSON.stringify(pathToFileURL(path.resolve('build/codex.ts')).href)};
try { await readCodex(${JSON.stringify(source)}, 'node@sha256:fixture') } catch {}`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    stdio: 'ignore'
  })
  const exit = new Promise<number | null>((resolve) => {
    child.once('exit', resolve)
  })

  try {
    await waitForStart(started, () => child.exitCode)

    expect(existsSync(started)).toBe(true)
    child.kill('SIGTERM')
    expect(await Promise.race([exit, delay(2000).then(() => 'timeout')])).toBe(143)
    expect(existsSync(cleaned)).toBe(true)
  } finally {
    child.kill('SIGKILL')

    killStarted(started)

    rmSync(dir, { force: true, recursive: true })
  }
})
