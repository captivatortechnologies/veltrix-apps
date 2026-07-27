import validate, { extractDestinationProfileSpecs, splitEntries } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('destination-profiles validate', () => {
  it('accepts a valid profile', () => {
    const r = validate(
      ctxWith([{ name: 'Banned', fields: { name: 'Banned', type: 'regex', values: '.*\\.evil\\.com' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'regex' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid type', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', type: 'glob' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('warns when no values are set', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', type: 'regex' } }]))
    expect(r.warnings.some((w) => w.code === 'no_values')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', type: 'regex', values: 'a' } },
        { name: 'Dup', fields: { name: 'Dup', type: 'sensitive', values: 'b' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractDestinationProfileSpecs', () => {
  it('reads fields, values and labels, defaulting type', () => {
    const specs = extractDestinationProfileSpecs({
      items: [
        { id: 'i1', name: 'F', fields: { name: ' Banned ', values: 'a.com\nb.com', labels: 'Prod' } },
      ],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Banned')
    expect(specs[0].type).toBe('insensitive')
    expect(specs[0].values).toEqual(['a.com', 'b.com'])
    expect(specs[0].labels).toEqual(['Prod'])
  })
})

describe('splitEntries', () => {
  it('splits arrays and delimited strings, trimming', () => {
    expect(splitEntries(['a', ' b '])).toEqual(['a', 'b'])
    expect(splitEntries('a\nb, c')).toEqual(['a', 'b', 'c'])
  })
})
