import { run } from '../shared/exec.ts'
import { codexNames } from '../sources/index.ts'
import path from 'node:path'

import type { CodexData } from './index.ts'

const parseCodex: (text: string) => CodexData = JSON.parse

function codexScript(): string {
  return `
const [api, events, widgets, cvars, types, combat, templates, chapters] =
  await Promise.all(${JSON.stringify(codexNames)}.map(name => import('/input/src/data/' + name + '.ts')));
console.log(JSON.stringify({
  API_FUNCTIONS: api.API_FUNCTIONS, EVENTS: events.EVENTS, WIDGETS: widgets.WIDGETS,
  CVARS: cvars.CVARS, DATA_TYPES: types.DATA_TYPES,
  COMBAT_LOG_SUB_EVENTS: combat.COMBAT_LOG_SUB_EVENTS, COMBAT_LOG_PREFIXES: combat.COMBAT_LOG_PREFIXES,
  SECURE_TEMPLATES: templates.SECURE_TEMPLATES, CHAPTER_PAGES: chapters.CHAPTER_PAGES
}));`
}

function killEvaluation(kill: () => boolean): void {
  kill()
}

export async function evaluateCodex(
  directory: string,
  nodeImage: string,
  container: string,
  signal: Readonly<AbortSignal>
): Promise<CodexData> {
  const script = codexScript()
  const mount = `type=bind,"src=${path.resolve(directory).replaceAll('"', '""')}",dst=/input,readonly`
  const evaluation = run(
    'docker',
    [
      'run',
      '--name',
      container,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      'node',
      '--mount',
      mount,
      nodeImage,
      'node',
      '--input-type=module',
      '-e',
      script
    ],
    { killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, signal, timeout: 60_000 }
  )

  const killChild = killEvaluation.bind(
    undefined,
    evaluation.child.kill.bind(evaluation.child, 'SIGKILL')
  )

  signal.addEventListener('abort', killChild)
  try {
    if (signal.aborted) {
      killChild()
    }
    const { stdout } = await evaluation
    return parseCodex(stdout)
  } finally {
    signal.removeEventListener('abort', killChild)
  }
}
