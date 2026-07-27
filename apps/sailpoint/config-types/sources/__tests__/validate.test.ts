import validate, { extractSourceSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('sources validate', () => {
  it('accepts a valid source', () => {
    const r = validate(ctxWith([{ name: 'AD', fields: { name: 'AD', ownerId: '2c91own', connectorName: 'active-directory-direct' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { ownerId: 'o', connectorName: 'c' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires an owner and connector', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].ownerId')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].connectorName')).toBe(true)
  })

  it('rejects invalid connector attributes JSON', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', ownerId: 'o', connectorName: 'c', connectorAttributes: '{ bad' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_attributes')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', ownerId: 'o', connectorName: 'c' } },
        { name: 'Dup', fields: { name: 'Dup', ownerId: 'o', connectorName: 'c' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractSourceSpecs', () => {
  it('reads fields and stringifies an object attributes blob', () => {
    const specs = extractSourceSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', description: 'd', ownerId: 'o', connectorName: 'c', connectorAttributes: { host: 'h' }, deleteThreshold: 10 } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].connectorAttributesRaw).toBe('{"host":"h"}')
    expect(specs[0].deleteThreshold).toBe(10)
  })
})
