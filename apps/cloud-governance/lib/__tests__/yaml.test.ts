import { toYaml, quoteString } from '../compiler/yaml'

describe('toYaml structure', () => {
  it('emits block style with two-space indentation and insertion-ordered keys', () => {
    expect(toYaml({ b: 1, a: { c: true, d: null }, list: ['x', 2] })).toBe(
      ['b: 1', 'a:', '  c: true', '  d: null', 'list:', '  - "x"', '  - 2', ''].join('\n'),
    )
  })

  it('emits arrays of objects with the first key on the dash line', () => {
    expect(toYaml({ items: [{ type: 'value', key: 'k' }, { type: 'x' }] })).toBe(
      ['items:', '  - type: "value"', '    key: "k"', '  - type: "x"', ''].join('\n'),
    )
  })

  it('emits nested arrays and arrays inside list objects', () => {
    expect(toYaml({ m: [['a', 'b'], [{ k: [1] }]] })).toBe(
      ['m:', '  - - "a"', '    - "b"', '  - - k:', '        - 1', ''].join('\n'),
    )
  })

  it('emits empty collections inline and skips undefined values', () => {
    expect(toYaml({ a: [], b: {}, c: undefined, d: { e: undefined } })).toBe('a: []\nb: {}\nd: {}\n')
  })

  it('emits scalars at the top level', () => {
    expect(toYaml('x')).toBe('"x"\n')
    expect(toYaml(null)).toBe('null\n')
  })

  it('refuses values YAML cannot represent', () => {
    let failed = 0
    for (const bad of [NaN, Infinity, () => 1, Symbol('s'), BigInt(1)]) {
      try {
        toYaml({ bad })
      } catch {
        failed += 1
      }
    }
    expect(failed).toBe(5)
  })
})

describe('toYaml strings', () => {
  const tricky = [
    'plain',
    '',
    'a: b',
    'has # hash',
    '# leading hash',
    '- leading dash',
    '-',
    '"quoted"',
    "it's",
    'back\\slash',
    'line1\nline2',
    'tab\there',
    'yes',
    'null',
    '123',
    '1e3',
    '~',
    '*alias',
    '&anchor',
    '!tag',
    '{flow}',
    '[seq]',
    '%directive',
    '@at',
    '`tick',
    '|literal',
    '>folded',
    '---',
    'ünïcödé ✓ 日本語 😀',
    'sep line para\u0085next',
    'del\u007fchar',
    '\u0000nul',
  ]

  it.each(tricky)('always double-quotes %j', (value) => {
    const out = quoteString(value)
    expect(out.startsWith('"')).toBe(true)
    expect(out.endsWith('"')).toBe(true)
    expect(out.includes('\n')).toBe(false)
    expect(toYaml({ k: value })).toBe(`k: ${out}\n`)
  })

  it('escapes characters YAML 1.1 parsers treat as line breaks or non-printable', () => {
    expect(quoteString('a b')).toBe('"a\\u2028b"')
    expect(quoteString('a\u0085b')).toBe('"a\\u0085b"')
    expect(quoteString('a\u007fb')).toBe('"a\\u007fb"')
  })

  it('cannot be tricked into injecting keys through a value', () => {
    const out = toYaml({ name: 'x"\nmode:\n  type: evil' })
    expect(out.split('\n')).toHaveLength(2)
  })
})

describe('toYaml keys', () => {
  it('leaves simple keys bare and quotes everything else', () => {
    expect(toYaml({ 'max-resources': 1, 'tag:Owner': 'a', 'has space': 1, y: 1, No: 2, null: 3, '1st': 4 })).toBe(
      ['max-resources: 1', '"tag:Owner": "a"', '"has space": 1', '"y": 1', '"No": 2', '"null": 3', '"1st": 4', ''].join('\n'),
    )
  })

  it('quotes injection-shaped keys', () => {
    expect(toYaml({ 'a: b\nc': 1 })).toBe('"a: b\\nc": 1\n')
  })
})
