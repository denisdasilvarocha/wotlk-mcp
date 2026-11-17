import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const [command, ...args] = process.argv.slice(2)

import {
  assetOf,
  authorize,
  base,
  digestPattern,
  download,
  hashFile,
  headers,
  json,
  list,
  previous,
  request,
  usedVersions,
  validRelease,
  versionPattern
} from './database-release-helpers.mjs'
import {
  readAsset,
  readRelease,
  runGate,
  validateMatrix,
  writeOutput
} from './database-release-readers.mjs'

if (command === 'previous') {
  const [output, versions] = args

  if (!output || args.length > 2) {
    throw new Error('usage: previous OUTPUT.sqlite [VERSIONS.json]')
  }

  if (versions !== undefined && versions !== '') {
    await usedVersions(versions)
  }

  const tag = await previous(output)

  if (tag !== undefined && tag !== '') {
    console.log(tag)
  }
} else if (command === 'create') {
  await authorize()

  const [report, database, ...files] = args

  if (!report || !database || files.length === 0) {
    throw new Error('usage: create GATE.json CANDIDATE.sqlite ASSET...')
  }

  /** @type {unknown} */
  const gate = JSON.parse(readFileSync(report, 'utf8'))
  if (typeof gate !== 'object' || gate === null || !('version' in gate)) {
    throw new Error('invalid version or duplicate asset names')
  }
  const tag = `db-v${String(gate.version)}`

  if (
    !versionPattern.test(tag) ||
    new Set(files.map((file) => path.basename(file))).size !== files.length
  ) {
    throw new Error('invalid version or duplicate asset names')
  }

  for (const name of [
    'wotlk.sqlite.br',
    'NOTICE.md',
    'fidelity.json',
    'build-report.json',
    'gate.json'
  ]) {
    if (!files.some((file) => path.basename(file) === name)) {
      throw new Error(`missing release asset: ${name}`)
    }
  }

  const releases = await list('releases')

  if (releases.some((release) => release.tag_name === tag)) {
    throw new Error('release tag already exists')
  }

  const ref = await fetch(`${base}/git/ref/tags/${tag}`, { headers })

  if (ref.status !== 404) {
    throw new Error('tag exists or cannot be checked')
  }

  const temporary = mkdtempSync(path.join(tmpdir(), 'wotlk-release-gate-'))

  try {
    const old = path.join(temporary, 'previous.sqlite')
    const oldTag = await previous(old)
    const versions = path.join(temporary, 'versions.json')

    await usedVersions(versions)

    const asset = files.find((file) => path.basename(file) === 'wotlk.sqlite.br')
    if (asset === undefined) {
      throw new Error('missing release asset: wotlk.sqlite.br')
    }
    const argumentsForGate = [
      'scripts/release-gate.ts',
      database,
      asset,
      `--used-versions=${versions}`
    ]

    if (oldTag !== undefined && oldTag !== '') {
      argumentsForGate.push(old)
    }

    if ('allow_shrink' in gate && gate.allow_shrink === true) {
      argumentsForGate.push('--allow-shrink')
    }

    // Async: a blocked event loop keeps idle API sockets the server already closed.
    const stdout = await runGate(argumentsForGate)
    /** @type {unknown} */
    const checked = JSON.parse(stdout)

    if (JSON.stringify(checked) !== JSON.stringify(gate)) {
      throw new Error('gate report does not match candidate and previous release')
    }

    const uploadedReport = files.find((file) => path.basename(file) === 'gate.json')
    if (uploadedReport === undefined) {
      throw new Error('missing release asset: gate.json')
    }

    if (readFileSync(uploadedReport, 'utf8') !== readFileSync(report, 'utf8')) {
      throw new Error('gate report asset mismatch')
    }
  } finally {
    rmSync(temporary, { force: true, recursive: true })
  }

  const body = readFileSync(report, 'utf8')
  const noticePath = files.find((file) => path.basename(file) === 'NOTICE.md')
  if (noticePath === undefined) {
    throw new Error('missing release asset: NOTICE.md')
  }
  const notice = readFileSync(noticePath, 'utf8')
  const release = readRelease(
    await json(`${base}/releases`, {
      body: JSON.stringify({
        body: `Database gate report:\n\n\`\`\`json\n${body}\n\`\`\`\n\n${notice}`,
        draft: true,
        name: tag,
        prerelease: false,
        tag_name: tag,
        target_commitish: process.env.GITHUB_SHA
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })
  )

  if (!release.draft || release.tag_name !== tag || !Number.isSafeInteger(release.id)) {
    throw new Error('invalid created draft')
  }

  await Promise.all(
    files.map(async (file) => {
      const uploadUrl = new URL(release.upload_url.replace(/\{.*$/u, ''))

      uploadUrl.searchParams.set('name', path.basename(file))

      const uploaded = readAsset(
        await json(uploadUrl.toString(), {
          body: () => Readable.toWeb(createReadStream(file)),
          duplex: 'half',
          headers: {
            'Content-Length': String(statSync(file).size),
            'Content-Type': 'application/octet-stream'
          },
          method: 'POST'
        })
      )

      if (uploaded.digest !== (await hashFile(file)) || uploaded.state !== 'uploaded') {
        throw new Error(`uploaded digest mismatch: ${file}`)
      }
    })
  )

  const saved = readRelease(await json(`${base}/releases/${release.id}`))
  const asset = assetOf(saved, 'wotlk.sqlite.br')

  validRelease(saved, String(release.id), tag, asset.digest)
  const result = { digest: asset.digest, id: release.id, tag }

  console.log(JSON.stringify(result))

  writeOutput(result)
} else if (command === 'download') {
  const [id, digest, output] = args

  if (
    !/^\d+$/u.test(id ?? '') ||
    !digestPattern.test(digest ?? '') ||
    !output ||
    args.length !== 3
  ) {
    throw new Error('usage: download ID DIGEST OUTPUT.br')
  }

  const release = readRelease(await json(`${base}/releases/${id}`))

  validRelease(release, id, release.tag_name, digest)
  await download(assetOf(release, 'wotlk.sqlite.br'), output)
} else if (command === 'promote') {
  await authorize()

  const [id, tag, digest] = args
  const runId = process.env.GITHUB_RUN_ID

  if (
    !/^\d+$/u.test(id ?? '') ||
    !/^\d+$/u.test(runId ?? '') ||
    !digestPattern.test(digest ?? '') ||
    args.length !== 3
  ) {
    throw new Error('usage: promote ID TAG DIGEST')
  }

  const release = readRelease(await json(`${base}/releases/${id}`))

  validRelease(release, id, tag, digest)

  const releases = await list('releases')

  if (releases.some((item) => item.tag_name === tag && String(item.id) !== id)) {
    throw new Error('conflicting release tag')
  }

  validateMatrix(await json(`${base}/actions/runs/${runId}/jobs?per_page=100`))

  const result = readRelease(
    await json(`${base}/releases/${id}`, {
      body: JSON.stringify({ draft: false, make_latest: 'false', prerelease: false }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH'
    })
  )

  if (result.draft || result.tag_name !== tag) {
    throw new Error('promotion result mismatch')
  }

  console.log(tag)
} else if (command === 'rollback') {
  await authorize()

  const [id, tag, operation] = args

  if (
    !/^\d+$/u.test(id ?? '') ||
    !versionPattern.test(tag ?? '') ||
    !['prerelease', 'delete'].includes(operation) ||
    args.length !== 3
  ) {
    throw new Error('usage: rollback ID TAG prerelease|delete')
  }

  const release = readRelease(await json(`${base}/releases/${id}`))

  if (String(release.id) !== id || release.tag_name !== tag || release.draft) {
    throw new Error('published release identity mismatch')
  }

  if (operation === 'delete') {
    await request(`${base}/releases/${id}`, { method: 'DELETE' })
  } else {
    const updated = readRelease(
      await json(`${base}/releases/${id}`, {
        body: JSON.stringify({ prerelease: true }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH'
      })
    )

    if (!updated.prerelease || updated.tag_name !== tag || updated.draft) {
      throw new Error('rollback result mismatch')
    }
  }

  console.log(`${tag}: ${operation}`)
} else {
  throw new Error('usage: database-release.mjs previous|create|download|promote|rollback ...')
}
