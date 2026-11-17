import { asArray, asRecord } from './records.mjs'
import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'

/** @typedef {{ readonly id: number, readonly name: string, readonly state: string, readonly digest: string }} Asset */
/** @typedef {{ readonly id: number, readonly tag_name: string, readonly draft: boolean, readonly prerelease: boolean, readonly published_at: string | null, readonly upload_url: string, readonly assets?: readonly Asset[] }} Release */

/**
 * @param {(value: string) => void} resolve - Promise resolver.
 * @param {(reason: Readonly<Error>) => void} reject - Promise rejecter.
 * @param {Readonly<Error> | null} error - Execution error.
 * @param {string} output - Command output.
 */
function finishGate(resolve, reject, error, output) {
  if (error === null) {
    resolve(output)
  } else if (error instanceof Error) {
    reject(error)
  }
}

/**
 * @param {Readonly<{digest: string, id: number, tag: string}>} result - Release output.
 */
export function writeOutput(result) {
  if (process.env.GITHUB_OUTPUT !== undefined && process.env.GITHUB_OUTPUT !== '') {
    let output = ''
    for (const [key, value] of Object.entries(result)) {
      output += `${key}=${value}\n`
    }
    appendFileSync(process.env.GITHUB_OUTPUT, output)
  }
}

/**
 * @param {readonly string[]} args - Gate arguments.
 * @returns {Promise<string>} Gate output.
 */
export function runGate(args) {
  return new Promise((resolve, reject) => {
    execFile('vpx', args, { encoding: 'utf8' }, finishGate.bind(null, resolve, reject))
  })
}

/**
 * @param {unknown} value - Parsed asset.
 * @returns {Asset} Asset fields.
 */
export function readAsset(value) {
  const item = asRecord(value)
  if (
    typeof item.id !== 'number' ||
    typeof item.name !== 'string' ||
    typeof item.state !== 'string' ||
    typeof item.digest !== 'string'
  ) {
    throw new TypeError('invalid GitHub release asset')
  }
  return { digest: item.digest, id: item.id, name: item.name, state: item.state }
}

/**
 * @param {unknown} value - Parsed release.
 * @returns {Release} Release fields.
 */
export function readRelease(value) {
  const item = asRecord(value)
  if (typeof item.tag_name !== 'string') {
    throw new TypeError('invalid GitHub release tag')
  }
  return {
    assets:
      item.assets === undefined ? undefined : asArray(item.assets).map((asset) => readAsset(asset)),
    draft: Boolean(item.draft),
    id: typeof item.id === 'number' ? item.id : Number.NaN,
    prerelease: Boolean(item.prerelease),
    published_at: typeof item.published_at === 'string' ? item.published_at : null,
    tag_name: item.tag_name,
    upload_url: typeof item.upload_url === 'string' ? item.upload_url : ''
  }
}

/**
 * @param {unknown} value - Parsed tag.
 * @returns {{readonly name: string}} Tag fields.
 */
export function readTag(value) {
  const item = asRecord(value)
  if (typeof item.name !== 'string') {
    throw new TypeError('invalid GitHub tag')
  }
  return { name: item.name }
}

/**
 * @param {unknown} value - Parsed environment.
 * @param {string} owner - Expected reviewer.
 * @returns {boolean} Whether the owner is the sole required reviewer.
 */
export function ownerApproved(value, owner) {
  const environment = asRecord(value)
  if (environment.protection_rules === undefined) {
    return false
  }
  return asArray(environment.protection_rules).some((entry) => {
    const rule = asRecord(entry)
    if (rule.type !== 'required_reviewers' || rule.reviewers === undefined) {
      return false
    }
    const reviewers = asArray(rule.reviewers)
    if (reviewers.length !== 1) {
      return false
    }
    const reviewer = asRecord(reviewers[0])
    if (reviewer.type !== 'User' || reviewer.reviewer === undefined) {
      return false
    }
    const user = asRecord(reviewer.reviewer)
    return typeof user.login === 'string' && user.login.toLowerCase() === owner
  })
}

/**
 * @param {unknown} value - Parsed jobs response.
 */
export function validateMatrix(value) {
  const response = asRecord(value)
  if (!Array.isArray(response.jobs)) {
    throw new TypeError('invalid matrix jobs')
  }
  const jobs = asArray(response.jobs).map((job) => asRecord(job))
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
    for (const node of ['24.15.0', 'node']) {
      const matches = jobs.filter((job) => job.name === `acceptance (${os}, ${node})`)
      if (
        matches.length !== 1 ||
        matches[0].status !== 'completed' ||
        matches[0].conclusion !== 'success'
      ) {
        throw new Error(`acceptance matrix failed: ${os} ${node}`)
      }
    }
  }
}
