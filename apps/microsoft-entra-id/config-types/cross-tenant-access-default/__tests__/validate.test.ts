import validate, {
  canonical,
  extractCrossTenantDefaultSpecs,
  parseObject,
} from '../validate'
import { buildBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('cross-tenant-access-default validate', () => {
  it('accepts a policy that sets inbound trust', () => {
    const r = validate(ctxWith([{ fields: { inboundTrustMfa: true } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid b2bCollaboration block', () => {
    const cfg = '{"b2bCollaborationOutbound":{"applications":{"accessType":"blocked","targets":[]}}}'
    const r = validate(ctxWith([{ fields: { b2bCollaboration: cfg } }]))
    expect(r.valid).toBe(true)
  })

  it('rejects more than one policy item (singleton)', () => {
    const r = validate(ctxWith([{ fields: {} }, { fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('rejects invalid b2bCollaboration JSON', () => {
    const r = validate(ctxWith([{ fields: { b2bCollaboration: '{not json' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('warns that automatic user consent is read-only on the default policy', () => {
    const r = validate(ctxWith([{ fields: { autoConsentInbound: true } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'auto_consent_readonly')).toBe(true)
  })

  it('warns on an unrecognized b2bCollaboration block key', () => {
    const r = validate(ctxWith([{ fields: { b2bCollaboration: '{"nonsense":{}}' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'unknown_block')).toBe(true)
  })

  it('warns on an invalid accessType inside a block', () => {
    const cfg = '{"b2bCollaborationInbound":{"usersAndGroups":{"accessType":"maybe","targets":[]}}}'
    const r = validate(ctxWith([{ fields: { b2bCollaboration: cfg } }]))
    expect(r.warnings.some((w) => w.code === 'invalid_access_type')).toBe(true)
  })

  it('warns when nothing is set', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'no_effective_change')).toBe(true)
  })

  it('reads checkboxes as real booleans', () => {
    const specs = extractCrossTenantDefaultSpecs({ items: [{ fields: { inboundTrustMfa: true } }] } as never)
    expect(specs[0].inboundTrustMfa).toBe(true)
    expect(specs[0].inboundTrustCompliantDevice).toBe(false)
  })
})

describe('buildBody', () => {
  it('always sends inboundTrust with the exact Graph property names', () => {
    const spec = extractCrossTenantDefaultSpecs({
      items: [{ fields: { inboundTrustMfa: true, inboundTrustHybridJoined: true } }],
    } as never)[0]
    const body = buildBody(spec) as { inboundTrust: Record<string, boolean> }
    expect(body.inboundTrust).toEqual({
      isMfaAccepted: true,
      isCompliantDeviceAccepted: false,
      isHybridAzureADJoinedDeviceAccepted: true,
    })
  })

  it('omits automaticUserConsentSettings unless opted in', () => {
    const off = extractCrossTenantDefaultSpecs({ items: [{ fields: {} }] } as never)[0]
    expect('automaticUserConsentSettings' in buildBody(off)).toBe(false)

    const on = extractCrossTenantDefaultSpecs({ items: [{ fields: { autoConsentOutbound: true } }] } as never)[0]
    const body = buildBody(on) as { automaticUserConsentSettings: Record<string, boolean> }
    expect(body.automaticUserConsentSettings).toEqual({ inboundAllowed: false, outboundAllowed: true })
  })

  it('merges only recognized b2b blocks into the body', () => {
    const cfg = '{"b2bCollaborationOutbound":{"applications":{"accessType":"blocked"}},"bogus":{"x":1}}'
    const spec = extractCrossTenantDefaultSpecs({ items: [{ fields: { b2bCollaboration: cfg } }] } as never)[0]
    const body = buildBody(spec)
    expect('b2bCollaborationOutbound' in body).toBe(true)
    expect('bogus' in body).toBe(false)
  })
})

describe('helpers', () => {
  it('treats an empty string as an empty object', () => {
    expect(parseObject('')).toEqual({})
  })

  it('rejects a JSON array', () => {
    expect(parseObject('[1,2]')).toBe(null)
  })

  it('canonicalizes equal values regardless of key order', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }))
  })
})
