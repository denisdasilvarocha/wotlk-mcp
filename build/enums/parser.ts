// Definitions are read from the pinned AzerothCore headers, GPL-2.0-or-later;
// see data/world/azerothcore-LICENSE.txt and data/world/azerothcore-AUTHORS.txt.

const precedence: Readonly<Record<string, number>> = {
  '%': 6,
  '&': 3,
  '*': 6,
  '+': 5,
  '-': 5,
  '/': 6,
  '<<': 4,
  '>>': 4,
  '^': 2,
  '|': 1
}

type EnumEntry = { readonly value: number; readonly name: string }
type EnumSymbols = { readonly get: (name: string) => bigint | undefined }

class ExpressionParser {
  private index = 0
  private readonly tokens: readonly string[]
  private readonly enumName: string
  private readonly expression: string
  private readonly symbols: EnumSymbols
  private readonly external: readonly EnumEntry[]

  constructor(
    tokens: readonly string[],
    enumName: string,
    expression: string,
    symbols: EnumSymbols,
    external: readonly EnumEntry[]
  ) {
    this.tokens = tokens
    this.enumName = enumName
    this.expression = expression
    this.symbols = symbols
    this.external = external
  }

  parse(): bigint {
    const value = this.evaluate()

    if (this.index !== this.tokens.length) {
      throw new Error(`Invalid ${this.enumName} expression: ${this.expression}`)
    }

    return value
  }

  private operand(): bigint {
    const token = this.tokens[this.index++]

    if (token === '(') {
      const value = this.evaluate()

      if (this.tokens[this.index++] !== ')') {
        throw new Error(`Invalid ${this.enumName} expression: ${this.expression}`)
      }

      return value
    }

    if (token === '+' || token === '-' || token === '~') {
      const value = this.evaluate(7)

      if (token === '-') {
        return -value
      }

      return token === '~' ? ~value : value
    }

    if (token && /^(?:0[xX][\da-fA-F]+|\d+)[uUlL]*$/u.test(token)) {
      return BigInt(token.replace(/[uUlL]+$/u, ''))
    }

    const found =
      this.symbols.get(token) ?? this.external.find((entry) => entry.name === token)?.value

    if (found === undefined) {
      throw new Error(`Unknown ${this.enumName} symbol ${token}`)
    }

    return BigInt(found)
  }

  private evaluate(minimum = 0): bigint {
    let left = this.operand()

    while (
      this.index < this.tokens.length &&
      (precedence[this.tokens[this.index]] ?? 0) >= minimum &&
      precedence[this.tokens[this.index]]
    ) {
      const operator = this.tokens[this.index++]
      const right = this.evaluate(precedence[operator] + 1)

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
}

function parseExpression(
  expression: string,
  enumName: string,
  symbols: EnumSymbols,
  external: readonly EnumEntry[]
): bigint {
  const tokens =
    expression.match(
      /0[xX][\da-fA-F]+(?:[uUlL]+)?|\d+(?:[uUlL]+)?|[A-Za-z_]\w*|<<|>>|[()+\-~|&^*/%]/gu
    ) ?? []

  if (tokens.join('') !== expression.replaceAll(/\s+/gu, '')) {
    throw new Error(`Unsupported ${enumName} expression: ${expression}`)
  }

  return new ExpressionParser(tokens, enumName, expression, symbols, external).parse()
}

export function parseEnum(
  source: string,
  enumName: string,
  external: readonly EnumEntry[] = []
): { value: number; name: string }[] {
  const clean = source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\n]*/gu, '')
  const match = clean.match(new RegExp(`\\benum\\s+${enumName}\\b[^;{}]*\\{([^}]*)\\}`, 'u'))

  if (!match) {
    throw new Error(`Missing pinned enum ${enumName}`)
  }

  let previous = -1n
  const symbols = new Map<string, bigint>()

  for (const member of match[1].split(',')) {
    if (!member.trim()) {
      continue
    }

    const parts = member.trim().match(/^([A-Za-z_]\w*)(?:\s*=\s*([\s\S]+))?$/u)

    if (!parts) {
      throw new Error(`Invalid ${enumName} member: ${member}`)
    }

    const [, memberName, expression] = parts
    let value = previous + 1n

    if (expression) {
      value = parseExpression(expression, enumName, symbols, external)
    }

    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Out-of-range ${enumName} value: ${value}`)
    }

    symbols.set(memberName, value)
    previous = value
  }

  if (symbols.size === 0) {
    throw new Error(`Empty pinned enum ${enumName}`)
  }

  return [...symbols].map(([name, value]: readonly [string, bigint]) => ({
    name,
    value: Number(value)
  }))
}
