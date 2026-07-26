import validate, { parseAttributes, extractTransformSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('transforms validate', () => {
  it('accepts a valid dateFormat transform', () => {
    const r = validate(
      ctxWith([
        {
          name: ' To Date',
          fields: {
            name: 'To Date',
            type: 'dateFormat',
            attributes: '{"inputFormat":"MMM dd yyyy","outputFormat":"yyyy/MM/dd"}',
          },
        },
      ])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a simple lower transform with no attributes', () => {
    const r = validate(ctxWith([{ name: 'Lower', fields: { name: 'Lower', type: 'lower' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_attributes')).toBe(false)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'lower' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a type', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', attributes: '{}' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than 50 chars', () => {
    const long = 'x'.repeat(51)
    const r = validate(ctxWith([{ name: long, fields: { name: long, type: 'lower' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_length')).toBe(true)
  })

  it('rejects invalid attributes JSON', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', type: 'concat', attributes: '{not json' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_attributes')).toBe(true)
  })

  it('rejects attributes that are not an object', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', type: 'concat', attributes: '[1,2,3]' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_attributes')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', type: 'lower' } },
        { name: 'Dup', fields: { name: 'Dup', type: 'upper' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('warns when a non-trivial type has empty attributes', () => {
    const r = validate(ctxWith([{ name: 'C', fields: { name: 'C', type: 'concat' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_attributes')).toBe(true)
  })
})

describe('parseAttributes', () => {
  it('treats blank as an empty object', () => {
    expect(parseAttributes('')).toEqual({ ok: true, value: {} })
  })
  it('parses an object', () => {
    expect(parseAttributes('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  })
  it('rejects arrays and scalars', () => {
    expect(parseAttributes('[1]').ok).toBe(false)
    expect(parseAttributes('42').ok).toBe(false)
  })
})

describe('extractTransformSpecs', () => {
  it('stringifies an object-valued attributes field', () => {
    const specs = extractTransformSpecs({
      items: [{ id: 'i1', name: 'T', fields: { name: 'T', type: 'static', attributes: { value: 'x' } } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].attributesRaw).toBe('{"value":"x"}')
  })
})
