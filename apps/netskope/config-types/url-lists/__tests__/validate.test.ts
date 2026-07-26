import validate, { splitEntries, extractUrlListSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('url-lists validate', () => {
  it('accepts a valid exact list', () => {
    const r = validate(ctxWith([{ name: 'Blocked', fields: { name: 'Blocked', type: 'exact', urls: 'a.com\nb.com' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'exact', urls: 'a.com' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid type', () => {
    const r = validate(ctxWith([{ name: 'L', fields: { name: 'L', type: 'glob', urls: 'a.com' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('warns on an empty list', () => {
    const r = validate(ctxWith([{ name: 'Empty', fields: { name: 'Empty', type: 'exact' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_urls')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', type: 'exact', urls: 'a.com' } },
        { name: 'Dup', fields: { name: 'Dup', type: 'regex', urls: '.*' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitEntries', () => {
  it('splits arrays and delimited strings, trimming', () => {
    expect(splitEntries(['a.com', ' b.com '])).toEqual(['a.com', 'b.com'])
    expect(splitEntries('a.com\nb.com, c.com')).toEqual(['a.com', 'b.com', 'c.com'])
    expect(splitEntries('')).toEqual([])
  })
})

describe('extractUrlListSpecs', () => {
  it('lowercases type and parses urls', () => {
    const specs = extractUrlListSpecs({
      items: [{ id: 'i1', name: 'L', fields: { name: 'L', type: 'REGEX', urls: 'x\ny' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('regex')
    expect(specs[0].urls).toEqual(['x', 'y'])
  })
})
