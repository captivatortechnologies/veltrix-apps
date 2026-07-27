import validate, { extractSourceSchemaSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('source-schemas validate', () => {
  it('accepts a valid schema', () => {
    const r = validate(ctxWith([{ name: 'account', fields: { sourceName: 'AD', name: 'account', identityAttribute: 'sAMAccountName' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires source and schema name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].sourceName')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
  })

  it('rejects invalid attributes JSON', () => {
    const r = validate(ctxWith([{ name: 'account', fields: { sourceName: 'AD', name: 'account', attributes: '{bad}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_attributes')).toBe(true)
  })

  it('rejects duplicate schema names within a source', () => {
    const r = validate(
      ctxWith([
        { name: 'account', fields: { sourceName: 'AD', name: 'account' } },
        { name: 'account', fields: { sourceName: 'AD', name: 'account' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractSourceSchemaSpecs', () => {
  it('stringifies an array attributes field', () => {
    const specs = extractSourceSchemaSpecs({
      items: [{ id: 'i1', name: 'account', fields: { sourceName: 'AD', name: 'account', attributes: [{ name: 'x' }] } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].attributesRaw).toBe('[{"name":"x"}]')
  })
})
