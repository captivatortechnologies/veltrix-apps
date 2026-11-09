const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/
const RESERVED_KEYS: ReadonlySet<string> = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n', 'null', '~'])
const UNSAFE_CHARS = new RegExp('[\\u007f-\\u009f\\u2028\\u2029\\ufffe\\uffff]', 'g')
const INDENT = 2

type Lines = string[]

export function quoteString(value: string): string {
  return JSON.stringify(value).replace(
    UNSAFE_CHARS,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function formatKey(key: string): string {
  return PLAIN_KEY.test(key) && !RESERVED_KEYS.has(key.toLowerCase()) ? key : quoteString(key)
}

function isBlock(value: unknown): value is object {
  if (Array.isArray(value)) return value.length > 0
  return typeof value === 'object' && value !== null && Object.values(value).some((v) => v !== undefined)
}

function flat(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return quoteString(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('YAML emitter cannot represent a non-finite number')
    return String(value)
  }
  if (Array.isArray(value)) return '[]'
  if (typeof value === 'object') return '{}'
  throw new TypeError(`YAML emitter cannot represent a ${typeof value}`)
}

function renderBlock(value: object, indent: number): Lines {
  return Array.isArray(value) ? renderArray(value, indent) : renderObject(value as Record<string, unknown>, indent)
}

function renderObject(source: Record<string, unknown>, indent: number): Lines {
  const pad = ' '.repeat(indent)
  const lines: Lines = []
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (isBlock(value)) {
      lines.push(`${pad}${formatKey(key)}:`, ...renderBlock(value, indent + INDENT))
    } else {
      lines.push(`${pad}${formatKey(key)}: ${flat(value)}`)
    }
  }
  return lines
}

function renderArray(items: unknown[], indent: number): Lines {
  const pad = ' '.repeat(indent)
  const lines: Lines = []
  for (const item of items) {
    if (isBlock(item)) {
      const nested = renderBlock(item, indent + INDENT)
      lines.push(`${pad}- ${nested[0].slice(indent + INDENT)}`, ...nested.slice(1))
    } else {
      lines.push(`${pad}- ${flat(item)}`)
    }
  }
  return lines
}

export function toYaml(value: unknown): string {
  const lines = isBlock(value) ? renderBlock(value, 0) : [flat(value)]
  return `${lines.join('\n')}\n`
}
