import validate, { extractRemoteNetworkSpecs, isValidCidr } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('remote-networks validate', () => {
  it('accepts a valid remote network', () => {
    const r = validate(ctxWith([{ name: 'Branch', fields: { name: 'Branch', cidrs: '203.0.113.0/24' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { cidrs: '10.0.0.0/8' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate name', () => {
    const r = validate(ctxWith([
      { name: 'Branch', fields: { name: 'Branch', cidrs: '10.0.0.0/8' } },
      { name: 'branch', fields: { name: 'branch', cidrs: '10.0.0.0/8' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects an invalid CIDR', () => {
    const r = validate(ctxWith([{ name: 'Branch', fields: { name: 'Branch', cidrs: '999.1.1.1/24' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('warns on a remote network with no CIDRs', () => {
    const r = validate(ctxWith([{ name: 'Branch', fields: { name: 'Branch' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_cidrs')).toBe(true)
  })
})

describe('isValidCidr', () => {
  it('accepts an IPv4 CIDR and a plain address', () => {
    expect(isValidCidr('10.0.0.0/8')).toBe(true)
    expect(isValidCidr('192.168.1.1')).toBe(true)
  })
  it('rejects a bad prefix and octet', () => {
    expect(isValidCidr('10.0.0.0/40')).toBe(false)
    expect(isValidCidr('300.0.0.0/8')).toBe(false)
  })
})

describe('extractRemoteNetworkSpecs', () => {
  it('reads name, group and cidrs from fields', () => {
    const specs = extractRemoteNetworkSpecs({
      items: [{ id: 'i1', name: 'Branch', fields: { name: 'Branch', group: 'EMEA', cidrs: '10.0.0.0/8\n172.16.0.0/12' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Branch')
    expect(specs[0].group).toBe('EMEA')
    expect(specs[0].cidrs).toHaveLength(2)
  })
})
