import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'

test('complete reference builder refuses an existing output without altering it', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'complete-reference-'))
  const marker = path.join(output, 'marker')
  writeFileSync(marker, 'keep')
  const runner = execFileSync('which', ['vpx'], { encoding: 'utf8' }).trim()
  const result = spawnSync(runner, ['scripts/complete-reference.ts', output], { encoding: 'utf8' })
  expect(result.status).not.toBe(0)
  expect(readFileSync(marker, 'utf8')).toBe('keep')
})
