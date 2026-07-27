import validate, { isValidIpOrRange, normalizeVipIp, extractVipSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-vips validate', () => {
  it('accepts a valid static-nat VIP', () => {
    const r = validate(ctxWith([{ name: 'WebVip', fields: { name: 'WebVip', extip: '203.0.113.10', mappedip: '10.0.0.10' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a mapped range', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', extip: '203.0.113.10', mappedip: '10.0.0.10-10.0.0.20' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { extip: '203.0.113.10', mappedip: '10.0.0.10' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid external IP', () => {
    const r = validate(ctxWith([{ name: 'V', fields: { name: 'V', extip: '999.0.0.1', mappedip: '10.0.0.10' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_extip')).toBe(true)
  })

  it('requires ports when port forwarding is enabled', () => {
    const r = validate(ctxWith([{ name: 'PF', fields: { name: 'PF', extip: '203.0.113.10', mappedip: '10.0.0.10', portforward: 'enable', protocol: 'tcp' } }]))
    expect(r.errors.some((e) => e.code === 'missing_extport')).toBe(true)
    expect(r.errors.some((e) => e.code === 'missing_mappedport')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', extip: '203.0.113.1', mappedip: '10.0.0.1' } },
        { name: 'Dup', fields: { name: 'Dup', extip: '203.0.113.2', mappedip: '10.0.0.2' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('isValidIpOrRange', () => {
  it('validates single IPs and ranges', () => {
    expect(isValidIpOrRange('10.0.0.1')).toBe(true)
    expect(isValidIpOrRange('10.0.0.1-10.0.0.9')).toBe(true)
    expect(isValidIpOrRange('999.0.0.1')).toBe(false)
  })
})

describe('normalizeVipIp', () => {
  it('normalizes strings and [{range}] shapes', () => {
    expect(normalizeVipIp('10.0.0.1')).toBe('10.0.0.1')
    expect(normalizeVipIp([{ range: '10.0.0.1' }])).toBe('10.0.0.1')
    expect(normalizeVipIp(['10.0.0.1'])).toBe('10.0.0.1')
  })
})

describe('extractVipSpecs', () => {
  it('defaults extintf and lowercases portforward', () => {
    const specs = extractVipSpecs({
      items: [{ id: 'i1', name: 'V', fields: { name: 'V', extip: '1.1.1.1', mappedip: '2.2.2.2', portforward: 'ENABLE' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].extintf).toBe('any')
    expect(specs[0].portforward).toBe('enable')
  })
})
