const sqliteWhitespace = /[\t\n\f\r \uFEFF]/u
const tailWhitespace = /\s/u
const sqlName =
  /[a-z_\u0080-\u{10ffff}][\w$\u0080-\u{10ffff}]*|[$:@#](?:[\w$\u0080-\u{10ffff}]|::)+(?:\([^\t\n\f\r )]*\))?/iuy

export function extractSqlStatement(query: string, sourceSQL: string): string | undefined {
  if (query.includes('\0')) {
    return undefined
  }

  let offset = 0
  let start = -1
  let end = 0
  let terminated = false

  while (offset < query.length) {
    const triviaEnd = skipTrivia(query, offset, offset >= sourceSQL.length)

    if (triviaEnd === -1) {
      return undefined
    }
    if (triviaEnd !== offset) {
      offset = triviaEnd
      continue
    }
    if (terminated || offset >= sourceSQL.length) {
      return undefined
    }
    if (query[offset] === ';') {
      terminated = start !== -1
      offset++
      continue
    }
    if (start === -1) {
      start = offset
    }

    end = skipToken(query, offset)
    if (end === -1 || end > sourceSQL.length) {
      return undefined
    }
    offset = end
  }

  return start === -1 ? undefined : query.slice(start, end)
}

function skipTrivia(query: string, offset: number, inTail: boolean): number {
  if (sqliteWhitespace.test(query[offset]) || (inTail && tailWhitespace.test(query[offset]))) {
    return offset + 1
  }
  if (query.startsWith('--', offset)) {
    const lineEnd = query.indexOf('\n', offset + 2)

    return lineEnd === -1 ? query.length : lineEnd + 1
  }
  if (query.startsWith('/*', offset)) {
    const commentEnd = query.indexOf('*/', offset + 2)

    return commentEnd === -1 ? -1 : commentEnd + 2
  }

  return offset
}

function skipToken(query: string, offset: number): number {
  const opening = query[offset]

  if (opening === '[') {
    const end = query.indexOf(']', offset + 1)

    return end === -1 ? -1 : end + 1
  }
  if (opening === "'" || opening === '"' || opening === '`') {
    let end = query.indexOf(opening, offset + 1)

    while (end !== -1 && query[end + 1] === opening) {
      end = query.indexOf(opening, end + 2)
    }

    return end === -1 ? -1 : end + 1
  }

  sqlName.lastIndex = offset
  return sqlName.test(query) ? sqlName.lastIndex : offset + 1
}
