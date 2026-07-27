import validate, { extractResourceRestrictionSpecs, targetKey } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('resource-restrictions validate', () => {
  it('accepts a valid tenant restriction', () => {
    const r = validate(ctxWith([{ name: 'Acme', fields: { targetType: 'tenant', targetName: 'Acme', recordLimit: 1000 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a target name', () => {
    const r = validate(ctxWith([{ name: '', fields: { targetType: 'role' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid target type', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { targetType: 'user', targetName: 'bob' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_target_type')).toBe(true)
  })

  it('rejects a duplicate target', () => {
    const r = validate(ctxWith([
      { name: 'Acme', fields: { targetType: 'tenant', targetName: 'Acme', recordLimit: 1 } },
      { name: 'acme', fields: { targetType: 'tenant', targetName: 'acme', recordLimit: 2 } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_target')).toBe(true)
  })

  it('warns when no limits are set', () => {
    const r = validate(ctxWith([{ name: 'Acme', fields: { targetType: 'tenant', targetName: 'Acme' } }]))
    expect(r.warnings.some((w) => w.code === 'empty_restriction')).toBe(true)
  })
})

describe('targetKey / extractResourceRestrictionSpecs', () => {
  it('builds a case-insensitive target key', () => {
    expect(targetKey('Tenant', 'Acme')).toBe(targetKey('tenant', 'acme'))
  })
  it('reads fields', () => {
    const specs = extractResourceRestrictionSpecs({
      items: [{ id: 'i1', name: 'Acme', fields: { targetType: 'role', targetName: 'Analyst', dataWindow: 86400 } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].targetType).toBe('role')
    expect(specs[0].dataWindow).toBe(86400)
  })
})
