import validate, { isValidIpv4, extractIpPoolSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-ip-pools validate', () => {
  it('accepts a valid overload pool', () => {
    const r = validate(ctxWith([{ name: 'NatPool', fields: { name: 'NatPool', type: 'overload', startIp: '203.0.113.10', endIp: '203.0.113.20' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a one-to-one pool', () => {
    const r = validate(ctxWith([{ name: 'OneToOne', fields: { name: 'OneToOne', type: 'one-to-one', startIp: '203.0.113.1', endIp: '203.0.113.1' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'overload', startIp: '203.0.113.10', endIp: '203.0.113.20' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid type', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', type: 'fixed-port-range', startIp: '203.0.113.10', endIp: '203.0.113.20' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an invalid start or end IP', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', type: 'overload', startIp: '999.0.0.1', endIp: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_ip')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', type: 'overload', startIp: '203.0.113.1', endIp: '203.0.113.2' } },
        { name: 'Dup', fields: { name: 'Dup', type: 'overload', startIp: '203.0.113.3', endIp: '203.0.113.4' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('isValidIpv4', () => {
  it('validates IPv4 addresses', () => {
    expect(isValidIpv4('203.0.113.10')).toBe(true)
    expect(isValidIpv4('256.0.0.1')).toBe(false)
    expect(isValidIpv4('10.0.0')).toBe(false)
  })
})

describe('extractIpPoolSpecs', () => {
  it('lowercases and defaults the type', () => {
    const specs = extractIpPoolSpecs({
      items: [{ id: 'i1', name: 'P', fields: { name: 'P', type: 'ONE-TO-ONE', startIp: '203.0.113.1', endIp: '203.0.113.1' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('one-to-one')
  })
})
