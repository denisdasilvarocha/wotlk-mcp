import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'vite-plus/test'

test('client bundle verification rejects altered bytes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'client-bundle-'))
  try {
    const bundle = path.join(dir, 'client-inputs.tar.gz')
    writeFileSync(bundle, 'not the pinned release asset')
    const result = spawnSync('python3', ['build/verify-client-inputs.py', bundle], {
      encoding: 'utf8'
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('bundle SHA-256 mismatch')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
