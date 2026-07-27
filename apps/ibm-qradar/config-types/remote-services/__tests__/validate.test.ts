import validate, { extractRemoteServiceSpecs, isValidCidr } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('remote-services validate', () => {
  it('accepts a valid remote service', () => {
    const r = validate(ctxWith([{ name: 'DNS', fields: { name: 'DNS', cidrs: '198.51.100.0/24' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { cidrs: '10.0.0.0/8' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate name', () => {
    const r = validate(ctxWith([
      { name: 'DNS', fields: { name: 'DNS', cidrs: '10.0.0.0/8' } },
      { name: 'dns', fields: { name: 'dns', cidrs: '10.0.0.0/8' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects an invalid CIDR', () => {
    const r = validate(ctxWith([{ name: 'DNS', fields: { name: 'DNS', cidrs: 'not-a-cidr' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('warns on a remote service with no CIDRs', () => {
    const r = validate(ctxWith([{ name: 'DNS', fields: { name: 'DNS' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_cidrs')).toBe(true)
  })
})

describe('isValidCidr', () => {
  it('accepts an IPv4 CIDR and a plain address', () => {
    expect(isValidCidr('172.16.0.0/12')).toBe(true)
    expect(isValidCidr('8.8.8.8')).toBe(true)
  })
  it('rejects a bad octet', () => {
    expect(isValidCidr('256.0.0.0/8')).toBe(false)
  })
})

describe('extractRemoteServiceSpecs', () => {
  it('reads name, group and cidrs from fields', () => {
    const specs = extractRemoteServiceSpecs({
      items: [{ id: 'i1', name: 'DNS', fields: { name: 'DNS', group: 'Infra', cidrs: '8.8.8.8\n8.8.4.4' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('DNS')
    expect(specs[0].group).toBe('Infra')
    expect(specs[0].cidrs).toHaveLength(2)
  })
})
