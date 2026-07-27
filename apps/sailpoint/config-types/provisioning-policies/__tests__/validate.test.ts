import validate, { extractProvisioningPolicySpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('provisioning-policies validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(ctxWith([{ name: 'Create', fields: { sourceName: 'AD', usageType: 'CREATE', name: 'Account Create' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires source and name', () => {
    const r = validate(ctxWith([{ name: '', fields: { usageType: 'CREATE' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].sourceName')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
  })

  it('rejects an invalid usage type', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { sourceName: 'AD', usageType: 'NOPE', name: 'X' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })

  it('rejects duplicate usage types within a source', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { sourceName: 'AD', usageType: 'CREATE', name: 'A' } },
        { name: 'B', fields: { sourceName: 'AD', usageType: 'CREATE', name: 'B' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_usage')).toBe(true)
  })
})

describe('extractProvisioningPolicySpecs', () => {
  it('defaults usage type and stringifies fields', () => {
    const specs = extractProvisioningPolicySpecs({
      items: [{ id: 'i1', name: 'A', fields: { sourceName: 'AD', name: 'A', fields: [{ name: 'email' }] } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].usageType).toBe('CREATE')
    expect(specs[0].fieldsRaw).toBe('[{"name":"email"}]')
  })
})
