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
type Integer = {
  readonly value: bigint
  readonly unsigned: boolean
  readonly unknownType?: boolean
}
type EnumSymbols = { readonly get: (name: string) => Integer | undefined }

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

  parse(): Integer {
    const value = this.evaluate()
    if (this.index !== this.tokens.length || value.unknownType) {
      throw new Error(`Invalid ${this.enumName} expression: ${this.expression}`)
    }

    return value
  }

  private integer(value: bigint, unsigned: boolean): Integer {
    if (unsigned) return { value: BigInt.asUintN(32, value), unsigned }
    if (value < -2147483648n || value > 2147483647n) {
      throw new Error(`Unsupported ${this.enumName} integer overflow: ${this.expression}`)
    }
    return { value, unsigned }
  }

  private operand(): Integer {
    const token = this.tokens[this.index++]

    if (token === '(') {
      const value = this.evaluate()
      if (this.tokens[this.index++] !== ')') {
        throw new Error(`Invalid ${this.enumName} expression: ${this.expression}`)
      }
      return value
    }

    if (token === '+' || token === '-' || token === '~') {
      const operand = this.evaluate(7)
      if (operand.unknownType) {
        throw new Error(`Unsupported ${this.enumName} symbol type: ${this.expression}`)
      }
      const value = token === '-' ? -operand.value : token === '~' ? ~operand.value : operand.value
      return this.integer(value, operand.unsigned)
    }

    if (token && /^(?:0[xX][\da-fA-F]+|\d+)[uUlL]*$/u.test(token)) {
      if (/[lL]/u.test(token) || !/^(?:0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)[uU]?$/u.test(token)) {
        throw new Error(`Unsupported ${this.enumName} integer literal: ${token}`)
      }
      const digits = token.replace(/[uU]$/u, '')
      const value = BigInt(/^0[0-7]+$/u.test(digits) ? `0o${digits.slice(1)}` : digits)
      const unsigned = /[uU]$/u.test(token) || (digits.startsWith('0') && value > 2147483647n)
      if (value > (unsigned ? 4294967295n : 2147483647n)) {
        throw new Error(`Unsupported ${this.enumName} integer literal: ${token}`)
      }
      return this.integer(value, unsigned)
    }

    const found = this.symbols.get(token)
    if (found) return found
    const external = this.external.find((entry) => entry.name === token)
    if (
      external &&
      Number.isInteger(external.value) &&
      external.value >= -2147483648 &&
      external.value <= 2147483647
    ) {
      return { value: BigInt(external.value), unsigned: false, unknownType: true }
    }
    throw new Error(`Unknown or unsupported ${this.enumName} symbol ${token}`)
  }

  private evaluate(minimum = 0): Integer {
    let left = this.operand()

    while (
      this.index < this.tokens.length &&
      (precedence[this.tokens[this.index]] ?? 0) >= minimum &&
      precedence[this.tokens[this.index]]
    ) {
      const operator = this.tokens[this.index++]
      const right = this.evaluate(precedence[operator] + 1)
      const shift = operator === '<<' || operator === '>>'
      if (left.unknownType || (right.unknownType && !shift)) {
        throw new Error(`Unsupported ${this.enumName} symbol type: ${this.expression}`)
      }
      const unsigned = shift ? left.unsigned : left.unsigned || right.unsigned
      const a = unsigned && !shift ? BigInt.asUintN(32, left.value) : left.value
      const b = unsigned && !shift ? BigInt.asUintN(32, right.value) : right.value
      let value: bigint

      if (shift && (b < 0n || b >= 32n || (!left.unsigned && a < 0n))) {
        throw new Error(`Unsupported ${this.enumName} shift: ${this.expression}`)
      }
      if (!unsigned && a === -2147483648n && b === -1n && (operator === '/' || operator === '%')) {
        throw new Error(`Unsupported ${this.enumName} integer overflow: ${this.expression}`)
      }
      switch (operator) {
        case '|':
          value = a | b
          break
        case '^':
          value = a ^ b
          break
        case '&':
          value = a & b
          break
        case '<<':
          value = a << b
          if (!unsigned && value <= 4294967295n) value = BigInt.asIntN(32, value)
          break
        case '>>':
          value = a >> b
          break
        case '+':
          value = a + b
          break
        case '-':
          value = a - b
          break
        case '*':
          value = a * b
          break
        case '/':
          value = a / b
          break
        case '%':
          value = a % b
          break
        default:
          throw new Error(`Unsupported ${this.enumName} operator: ${operator}`)
      }
      left = this.integer(value, unsigned)
    }

    return left
  }
}

function parseExpression(
  expression: string,
  enumName: string,
  symbols: EnumSymbols,
  external: readonly EnumEntry[]
): Integer {
  if (/\+\+|--/u.test(expression)) {
    throw new Error(`Unsupported ${enumName} expression: ${expression}`)
  }

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
  const match = clean.match(new RegExp(`\\benum\\s+${enumName}\\b([^;{}]*)\\{([^}]*)\\}`, 'u'))

  if (!match) {
    throw new Error(`Missing pinned enum ${enumName}`)
  }
  const underlying = match[1].trim()
  if (underlying && !/^:\s*(?:u?int(?:8|16|32)|unsigned|int)$/u.test(underlying)) {
    throw new Error(`Unsupported ${enumName} underlying type: ${underlying}`)
  }
  const fixedUnsigned32 = /^:\s*(?:uint32|unsigned)$/u.test(underlying)
  const fixedSigned32 = /^:\s*(?:int32|int)$/u.test(underlying)
  const fixedSmall = underlying.match(/^:\s*(u?)int(8|16)$/u)
  const min =
    fixedUnsigned32 || fixedSmall?.[1]
      ? 0n
      : fixedSmall
        ? -(1n << (BigInt(fixedSmall[2]) - 1n))
        : -2147483648n
  const max = fixedSmall
    ? (1n << (BigInt(fixedSmall[2]) - (fixedSmall[1] ? 0n : 1n))) - 1n
    : fixedSigned32
      ? 2147483647n
      : 4294967295n

  let previous: Integer = { value: -1n, unsigned: false }
  const symbols = new Map<string, Integer>()

  for (const member of match[2].split(',')) {
    if (!member.trim()) {
      continue
    }

    const parts = member.trim().match(/^([A-Za-z_]\w*)(?:\s*=\s*([\s\S]+))?$/u)

    if (!parts) {
      throw new Error(`Invalid ${enumName} member: ${member}`)
    }

    const [, memberName, expression] = parts
    const value = expression
      ? parseExpression(expression, enumName, symbols, external)
      : { value: previous.value + 1n, unsigned: previous.unsigned }

    if (!expression && !underlying && !previous.unsigned && value.value > 2147483647n) {
      throw new Error(`Unsupported ${enumName} integer overflow: ${value.value}`)
    }

    if (value.value < min || value.value > max) {
      throw new Error(`Out-of-range ${enumName} value: ${value.value}`)
    }

    previous = underlying ? { value: value.value, unsigned: fixedUnsigned32 } : value
    symbols.set(memberName, previous)
  }

  if (symbols.size === 0) {
    throw new Error(`Empty pinned enum ${enumName}`)
  }

  return [...symbols].map(([name, value]: readonly [string, Integer]) => ({
    name,
    value: Number(value.value)
  }))
}

// Strips the members' common `PREFIX_`; an ordinal enum (1-based) becomes its bitmask values.
export function enumValues(entries: readonly EnumEntry[], ordinalMask = false): EnumEntry[] {
  const values = ordinalMask
    ? entries
        .filter((entry) => entry.value > 0)
        .map((entry) => ({ name: entry.name, value: 2 ** (entry.value - 1) }))
    : entries
  let prefix = values[0].name
  for (const entry of values) {
    while (!entry.name.startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
    }
  }
  prefix = prefix.slice(0, prefix.lastIndexOf('_') + 1)
  return values.map((entry) => ({
    name: entry.name.slice(prefix.length) || entry.name,
    value: entry.value
  }))
}
