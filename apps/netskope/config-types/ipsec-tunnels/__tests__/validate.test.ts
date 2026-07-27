import validate, { extractIpsecTunnelSpecs, asNumber } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('ipsec-tunnels validate', () => {
  it('accepts a valid tunnel', () => {
    const r = validate(
      ctxWith([{ name: 'HQ', fields: { site: 'HQ', source_ip: '203.0.113.10', pop_names: 'US-East', psk: 'secret' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a psk', () => {
    const r = validate(ctxWith([{ name: 'HQ', fields: { site: 'HQ', source_ip: '1.2.3.4', pop_names: 'US-East' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.psk'))).toBe(true)
  })

  it('requires a site, source ip and pop names', () => {
    const r = validate(ctxWith([{ name: '', fields: { psk: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.site'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.source_ip'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'no_pops')).toBe(true)
  })

  it('rejects an invalid source type', () => {
    const r = validate(ctxWith([{ name: 'HQ', fields: { site: 'HQ', source_ip: '1.2.3.4', pop_names: 'US-East', psk: 'x', source_type: 'switch' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_source_type')).toBe(true)
  })

  it('rejects duplicate sites', () => {
    const r = validate(
      ctxWith([
        { name: 'HQ', fields: { site: 'HQ', source_ip: '1.2.3.4', pop_names: 'US-East', psk: 'a' } },
        { name: 'HQ', fields: { site: 'HQ', source_ip: '5.6.7.8', pop_names: 'US-West', psk: 'b' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_site')).toBe(true)
  })
})

describe('asNumber', () => {
  it('parses numbers and falls back to 50', () => {
    expect(asNumber(100, 50)).toBe(100)
    expect(asNumber('', 50)).toBe(50)
  })
})

describe('extractIpsecTunnelSpecs', () => {
  it('reads fields, pops, psk and defaults', () => {
    const specs = extractIpsecTunnelSpecs({
      items: [{ id: 'i1', name: 'F', fields: { site: ' HQ ', source_ip: '1.2.3.4', pop_names: 'US-East', psk: ' sec ' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].site).toBe('HQ')
    expect(specs[0].psk).toBe('sec')
    expect(specs[0].bandwidth).toBe(50)
    expect(specs[0].enabled).toBe(true)
  })
})
