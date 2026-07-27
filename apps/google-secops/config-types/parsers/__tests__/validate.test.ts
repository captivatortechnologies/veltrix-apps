import validate, { extractParserSpecs } from '../validate'
import { decodeCbn, encodeCbn, normalizeCode, parserIdOf, activeParser } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('parsers validate', () => {
  it('accepts a valid parser', () => {
    const r = validate(ctxWith([{ name: 'p1', fields: { logType: 'WINEVTLOG', code: 'filter { }' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a log type and code', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid log type', () => {
    const r = validate(ctxWith([{ name: 'p1', fields: { logType: 'bad type!', code: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_log_type')).toBe(true)
  })

  it('rejects two parsers for the same log type', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { logType: 'WINEVTLOG', code: 'x' } },
        { name: 'b', fields: { logType: 'WINEVTLOG', code: 'y' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_log_type')).toBe(true)
  })
})

describe('extractParserSpecs / deploy helpers', () => {
  it('maps items to specs', () => {
    const specs = extractParserSpecs(ctxWith([{ id: 'i1', name: 'p', fields: { logType: 'WINEVTLOG', code: 'filter { }' } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].logType).toBe('WINEVTLOG')
  })

  it('round-trips base64 cbn and normalizes code', () => {
    const code = 'filter {\n  grok { }\n}'
    expect(decodeCbn(encodeCbn(code))).toBe(code)
    expect(normalizeCode('filter  {\n\n  grok {} }')).toBe(normalizeCode('filter { grok {} }'))
  })

  it('finds the active parser and the id tail', () => {
    const parsers = [
      { name: 'a/parsers/p1', state: 'INACTIVE' },
      { name: 'a/parsers/p2', state: 'ACTIVE' },
    ]
    expect(parserIdOf(activeParser(parsers)?.name ?? '')).toBe('p2')
    expect(activeParser([{ name: 'x', state: 'INACTIVE' }])).toBe(undefined)
  })
})
