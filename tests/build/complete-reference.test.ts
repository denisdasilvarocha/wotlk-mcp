import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'vite-plus/test'

test('complete reference builder refuses an existing output without altering it', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'complete-reference-'))

  try {
    const marker = path.join(output, 'marker')

    writeFileSync(marker, 'keep')

    const result = spawnSync(process.execPath, ['build/main.ts', output], {
      encoding: 'utf8'
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`Output already exists: ${output}. Nothing was changed.`)
    expect(readFileSync(marker, 'utf8')).toBe('keep')
  } finally {
    rmSync(output, { force: true, recursive: true })
  }
})

test.each([
  { args: ['--help'], name: 'help', success: true },
  { args: ['--unknown'], name: 'unknown options', success: false },
  { args: ['one', 'two'], name: 'extra positional arguments', success: false }
])(
  'build CLI handles $name before side effects',
  ({ args, success }: { readonly args: readonly string[]; readonly success: boolean }) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'build-cli-'))

    try {
      const result = spawnSync(process.execPath, [path.resolve('build/main.ts'), ...args], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, PATH: '' }
      })

      expect(result.status === 0).toBe(success)
      expect(`${result.stdout}${result.stderr}`).toContain(
        'Usage: vp run build [new-output-directory]'
      )
      expect(readdirSync(directory)).toEqual([])
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  }
)
