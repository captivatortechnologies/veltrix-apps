import validate, { extractCustomPropertySpecs, parseExpressions } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const expr = '[{"logSourceType":"Linux OS","regex":"user=(\\\\w+)","captureGroup":1}]'
const base = { name: 'Username', propertyType: 'string', expressions: expr }

describe('custom-event-properties validate', () => {
  it('accepts a valid custom property', () => {
    const r = validate(ctxWith([{ name: 'Username', fields: { ...base } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { ...base, name: '' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid property type', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { ...base, propertyType: 'boolean' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_property_type')).toBe(true)
  })

  it('requires format and locale for a time property', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { ...base, propertyType: 'time' } }]))
    expect(r.errors.some((e) => e.code === 'time_requires_format')).toBe(true)
  })

  it('rejects invalid expressions JSON', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { ...base, expressions: 'nope' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_expressions')).toBe(true)
  })

  it('rejects duplicate log source types within a property', () => {
    const dup = '[{"logSourceType":"Linux OS","regex":"a"},{"logSourceType":"linux os","regex":"b"}]'
    const r = validate(ctxWith([{ name: 'X', fields: { ...base, expressions: dup } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_log_source_type')).toBe(true)
  })
})

describe('parseExpressions', () => {
  it('parses an array of expressions with default capture group', () => {
    const { expressions, error } = parseExpressions('[{"logSourceType":"Linux OS","regex":"x"}]')
    expect(error).toBe(undefined)
    expect(expressions).toHaveLength(1)
    expect(expressions[0].captureGroup).toBe(1)
    expect(expressions[0].enabled).toBe(true)
  })
})

describe('extractCustomPropertySpecs', () => {
  it('reads name and property type from fields', () => {
    const specs = extractCustomPropertySpecs({
      items: [{ id: 'i1', name: 'Username', fields: { ...base } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Username')
    expect(specs[0].propertyType).toBe('string')
  })
})
