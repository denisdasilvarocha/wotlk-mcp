export interface Evidence {
  path: string
  line: number
  global?: string
  value?: string
  registry?: string
}

export interface Command {
  aliases: (Evidence & { value: string })[]
  handlers: Evidence[]
  emote: boolean
}

function commentStripper(): (text: string) => string | null {
  let blockComment = false

  return (text) => {
    let code = text

    if (blockComment) {
      const end = code.indexOf(']]')

      if (end < 0) {
        return null
      }

      code = code.slice(end + 2)
      blockComment = false
    }

    const block = code.indexOf('--[[')

    if (block >= 0) {
      const end = code.indexOf(']]', block + 4)

      if (end < 0) {
        code = code.slice(0, block)
        blockComment = true
      } else {
        code = code.slice(0, block) + code.slice(end + 2)
      }
    }

    return code
  }
}

export function commandParser(
  commands: Readonly<Map<string, Command>>
): (text: string, path: string, line: number) => void {
  const withoutBlockComment = commentStripper()

  function command(key: string, emote = false): Command {
    let value = commands.get(key)

    if (!value) {
      value = { aliases: [], emote, handlers: [] }
      commands.set(key, value)
    }

    return value
  }

  return (text, path, line) => {
    const code = withoutBlockComment(text)

    if (code === null || /^\s*--/u.test(code)) {
      return
    }

    const alias = code.match(
      /^\s*(SLASH_([A-Z][A-Z0-9_]*?)(\d+)|EMOTE(\d+)_CMD\d*)\s*=\s*(["'])(\/[^"']+)\5/u
    )

    if (alias) {
      const key = alias[2] ?? `EMOTE${alias[4]}`

      command(key, !!alias[4]).aliases.push({
        global: alias[1],
        line,
        path,
        value: alias[6]
      })
    }

    const handler = code.match(/^\s*(SecureCmdList|SlashCmdList)\s*\[\s*["']([^"']+)["']\s*\]\s*=/u)

    if (handler) {
      command(handler[2]).handlers.push({ line, path, registry: handler[1] })
    }
  }
}
