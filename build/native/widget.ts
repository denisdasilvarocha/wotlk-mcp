import { createHash } from 'node:crypto'

type WidgetLookup = { readonly get: (key: string) => readonly string[] | undefined }

export function sha(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sorted(names: readonly string[]): string {
  return JSON.stringify([...new Set(names)].toSorted())
}

export function declaringWidget(
  widget: string,
  name: string,
  widgets: WidgetLookup,
  inherited: WidgetLookup,
  parents: WidgetLookup
): string | undefined {
  if (widgets.get(widget)?.includes(name) === true) {
    return widget
  }
  if (inherited.get(widget)?.includes(name) !== true) {
    return undefined
  }

  const seen = new Set<string>([widget])
  const pending = [...(parents.get(widget) ?? [])]
  const matches = new Set<string>()

  while (pending.length > 0) {
    const parent = pending.pop()

    if (parent === undefined || parent === '' || seen.has(parent)) {
      continue
    }

    seen.add(parent)
    if (widgets.get(parent)?.includes(name) === true) {
      matches.add(parent)
    }
    pending.push(...(parents.get(parent) ?? []))
  }

  if (matches.size === 1) {
    return [...matches][0]
  }
  return undefined
}
