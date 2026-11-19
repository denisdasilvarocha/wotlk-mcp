export type Field = Readonly<{
  name: string
  type: string
  target?: string
  localized?: boolean
  size: number
  unsigned: boolean
}>

function compare(x: readonly number[], y: readonly number[]): number {
  for (let i = 0; i < 4; i++) {
    if (x[i] !== y[i]) {
      return x[i] - y[i]
    }
  }
  return 0
}

function matchesBuild(text: string): boolean {
  return text.split(',').some((part) => {
    const [a, b = a] = part
      .trim()
      .split('-')
      .map((v) => v.split('.').map(Number))
    return (
      a?.length === 4 &&
      b?.length === 4 &&
      compare(a, [3, 3, 5, 12340]) <= 0 &&
      compare(b, [3, 3, 5, 12340]) >= 0
    )
  })
}

function parseColumns(text: string): Map<string, { type: string; target?: string }> {
  const columns = new Map<string, { type: string; target?: string }>()
  for (const line of text.split(/\r?\n/u).slice(1)) {
    const match = /^(int|uint|float|string|locstring)(?:<([^>]+)>)?\s+(\w+)/u.exec(line)
    if (match) {
      columns.set(match[3], { target: match[2], type: match[1] })
    }
  }
  return columns
}

function parseFields(
  section: string,
  name: string,
  columns: Readonly<Pick<ReadonlyMap<string, Readonly<{ type: string; target?: string }>>, 'get'>>
): Field[] {
  const fields: Field[] = []
  for (const line of section.split(/\r?\n/u)) {
    if (!line || /^(BUILD|LAYOUT|COMMENT) /u.test(line)) {
      continue
    }
    const m = /^(?:\$([^$]+)\$)?(\w+)(?:<([^>]+)>)?(?:\[(\d+)\])?/u.exec(line)
    if (!m) {
      throw new Error(`Unrecognized ${name} layout: ${line}`)
    }
    if (m[1]?.includes('noninline')) {
      throw new Error(`Non-inline field in ${name}: ${line}`)
    }
    const col = columns.get(m[2])
    if (!col) {
      throw new Error(`Unrecognized ${name} layout: ${line}`)
    }
    const count = Number(m[4] ?? 1)
    for (let i = 0; i < count; i++) {
      fields.push({
        localized: col.type === 'locstring',
        name: count === 1 ? m[2] : `${m[2]}_${i + 1}`,
        size: Number(m[3]?.replace('u', '') ?? 32) / 8,
        target: col.target,
        type: col.type,
        unsigned: col.type === 'uint' || (m[3]?.startsWith('u') ?? false)
      })
    }
  }
  return fields
}

export function parseLayout(definition: string, name: string): Field[] {
  const sections = definition.split(/\r?\n\s*\r?\n/u)
  const columns = parseColumns(sections[0])
  const section = sections
    .slice(1)
    .find((part) =>
      part.split(/\r?\n/u).some((line) => line.startsWith('BUILD ') && matchesBuild(line.slice(6)))
    )
  if (section === undefined || section === '') {
    throw new Error(`Missing build 12340 layout: ${name}`)
  }
  return parseFields(section, name, columns)
}
