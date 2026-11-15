// Definitions are read from the pinned AzerothCore headers, GPL-2.0-or-later;
// see data/world/azerothcore-LICENSE.txt and data/world/azerothcore-AUTHORS.txt.

export function parseEnum(
  source: string,
  enumName: string,
  external: { value: number; name: string }[] = []
): { value: number; name: string }[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const match = clean.match(new RegExp(`\\benum\\s+${enumName}\\b[^;{}]*\\{([^}]*)\\}`))

  if (!match) throw new Error(`Missing pinned enum ${enumName}`)

  let previous = -1n
  const symbols = new Map<string, bigint>()

  for (const member of match[1].split(',')) {
    if (!member.trim()) continue

    const parts = member.trim().match(/^([A-Za-z_]\w*)(?:\s*=\s*([\s\S]+))?$/)

    if (!parts) throw new Error(`Invalid ${enumName} member: ${member}`)

    const [, memberName, expression] = parts
    let value = previous + 1n

    if (expression) {
      const tokens =
        expression.match(
          /0[xX][\da-fA-F]+(?:[uUlL]+)?|\d+(?:[uUlL]+)?|[A-Za-z_]\w*|<<|>>|[()+\-~|&^*/%]/g
        ) ?? []

      if (tokens.join('') !== expression.replace(/\s+/g, ''))
        throw new Error(`Unsupported ${enumName} expression: ${expression}`)

      let index = 0
      const precedence: Record<string, number> = {
        '|': 1,
        '^': 2,
        '&': 3,
        '<<': 4,
        '>>': 4,
        '+': 5,
        '-': 5,
        '*': 6,
        '/': 6,
        '%': 6
      }

      function evaluate(minimum = 0): bigint {
        let left: bigint
        const token = tokens[index++]

        if (token === '(') {
          left = evaluate()

          if (tokens[index++] !== ')')
            throw new Error(`Invalid ${enumName} expression: ${expression}`)
        } else if (token === '+' || token === '-' || token === '~') {
          const operand = evaluate(7)

          left = operand

          if (token === '-') left = -operand

          if (token === '~') left = ~operand
        } else if (token && /^(?:0[xX][\da-fA-F]+|\d+)[uUlL]*$/.test(token))
          left = BigInt(token.replace(/[uUlL]+$/, ''))
        else {
          const found = symbols.get(token) ?? external.find((entry) => entry.name === token)?.value

          if (found === undefined) throw new Error(`Unknown ${enumName} symbol ${token}`)

          left = BigInt(found)
        }

        while (
          index < tokens.length &&
          (precedence[tokens[index]] ?? 0) >= minimum &&
          precedence[tokens[index]]
        ) {
          const operator = tokens[index++]
          const right = evaluate(precedence[operator] + 1)

          switch (operator) {
            case '|':
              left |= right
              break
            case '^':
              left ^= right
              break
            case '&':
              left &= right
              break
            case '<<':
              left <<= right
              break
            case '>>':
              left >>= right
              break
            case '+':
              left += right
              break
            case '-':
              left -= right
              break
            case '*':
              left *= right
              break
            case '/':
              left /= right
              break
            case '%':
              left %= right
              break
          }
        }

        return left
      }

      value = evaluate()

      if (index !== tokens.length) throw new Error(`Invalid ${enumName} expression: ${expression}`)
    }

    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error(`Out-of-range ${enumName} value: ${value}`)

    symbols.set(memberName, value)
    previous = value
  }

  if (!symbols.size) throw new Error(`Empty pinned enum ${enumName}`)

  return [...symbols].map(([name, value]) => ({ name, value: Number(value) }))
}
