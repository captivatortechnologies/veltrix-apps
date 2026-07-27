import validate, { canonical, parseObject } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const TENANT = '11111111-2222-3333-4444-555555555555'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('cross-tenant-access-partners validate', () => {
  it('accepts a valid partner', () => {
    const r = validate(
      ctxWith([{ fields: { tenantId: TENANT, configuration: '{"inboundTrust":{"isMfaAccepted":true}}' } }]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a tenant id', () => {
    const r = validate(ctxWith([{ fields: { configuration: '{}' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a non-GUID tenant id', () => {
    const r = validate(ctxWith([{ fields: { tenantId: 'contoso.com' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_tenant_id')).toBe(true)
  })

  it('rejects invalid configuration JSON', () => {
    const r = validate(ctxWith([{ fields: { tenantId: TENANT, configuration: '{not json' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('warns on an unknown setting key', () => {
    const r = validate(ctxWith([{ fields: { tenantId: TENANT, configuration: '{"nonsense":true}' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'unknown_setting')).toBe(true)
  })

  it('rejects duplicate tenant ids', () => {
    const r = validate(
      ctxWith([{ fields: { tenantId: TENANT } }, { fields: { tenantId: TENANT } }]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_tenant_id')).toBe(true)
  })
})

describe('helpers', () => {
  it('treats an empty string as an empty object', () => {
    expect(parseObject('')).toEqual({})
  })

  it('canonicalizes equal values regardless of key order', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }))
  })
})
