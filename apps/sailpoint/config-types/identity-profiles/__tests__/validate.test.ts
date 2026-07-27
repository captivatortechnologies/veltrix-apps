import validate, { extractIdentityProfileSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('identity-profiles validate', () => {
  it('accepts a valid identity profile', () => {
    const r = validate(ctxWith([{ name: 'Employees', fields: { name: 'Employees', authoritativeSourceId: 'src1', priority: 10 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name and authoritative source', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].authoritativeSourceId')).toBe(true)
  })

  it('rejects a negative priority', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', authoritativeSourceId: 's', priority: -1 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_number')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', authoritativeSourceId: 's' } },
        { name: 'Dup', fields: { name: 'Dup', authoritativeSourceId: 's' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractIdentityProfileSpecs', () => {
  it('reads fields', () => {
    const specs = extractIdentityProfileSpecs({
      items: [{ id: 'i1', name: 'P', fields: { name: 'P', authoritativeSourceId: 's', priority: 5 } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].authoritativeSourceId).toBe('s')
    expect(specs[0].priority).toBe(5)
  })
})
