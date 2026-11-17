import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

type PromisifiedExecFile = typeof execFile & {
  readonly [promisify.custom]: typeof execFile.__promisify__
}

function hasPromisifyCustom(fn: unknown): fn is PromisifiedExecFile {
  return typeof fn === 'function' && promisify.custom in fn
}

function promisifiedExecFile(): typeof execFile.__promisify__ {
  if (!hasPromisifyCustom(execFile)) {
    throw new Error('execFile lacks util.promisify.custom')
  }

  return execFile[promisify.custom]
}

/** `promisify(execFile)`: resolves `{ stdout, stderr }`, exposes `.child`, rejects with stdout/stderr on the error. */
export const run = promisifiedExecFile()
