import { execFileSync } from 'node:child_process'
import { readdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'

export function unpackPackage(directory: string): void {
  execFileSync('vp', ['pm', 'pack', '--pack-destination', directory], { stdio: 'pipe' })
  const archive = readdirSync(directory).find((name) => name.endsWith('.tgz'))
  if (!archive) throw new Error('Package archive not created')
  execFileSync('tar', ['-xzf', path.join(directory, archive), '-C', directory])
  symlinkSync(
    path.resolve('node_modules'),
    path.join(directory, 'package', 'node_modules'),
    'junction'
  )
}
