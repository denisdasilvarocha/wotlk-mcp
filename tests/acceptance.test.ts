import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'vite-plus/test'

import { initReference } from '../build/offsets.ts'
import { packPackage } from './package.ts'

test('acceptance rejects malformed fixtures and unapproved World Data for a real packed server', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acceptance-'))

  try {
    const db = path.join(dir, 'reference.sqlite')

    initReference(db)

    const archive = packPackage(dir)
    const bad = path.join(dir, 'invalid.json')

    writeFileSync(bad, JSON.stringify([{ id: 'broken' }]))

    function run(file: string): ReturnType<typeof spawnSync> {
      return spawnSync('vpx', ['scripts/acceptance.ts', archive, db, file], {
        encoding: 'utf8'
      })
    }

    const invalid = run(bad)

    expect(invalid.status).not.toBe(0)
    expect(invalid.stderr).toContain('fixture')

    const unapproved = run('tests/fixtures/acceptance.json')

    expect(unapproved.status).not.toBe(0)
    expect(unapproved.stderr).toContain('UNAPPROVED')

    for (const id of ['O01', 'O02', 'O03', 'O04', 'O05', 'O06', 'O07', 'O08', 'O09', 'O10'])
      expect(unapproved.stdout).toContain(`PASS ${id}`)

    const altered = path.join(dir, 'altered.json')
    const source = readFileSync('tests/fixtures/acceptance.json', 'utf8')

    writeFileSync(altered, source.replace('0x0067CA30', '0xDEADBEEF'))

    const failed = run(altered)

    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain('O01:')
    expect(failed.stderr).toContain('0xDEADBEEF')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)
