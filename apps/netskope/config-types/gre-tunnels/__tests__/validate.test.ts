import validate, { extractGreTunnelSpecs, asNumber } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('gre-tunnels validate', () => {
  it('accepts a valid tunnel', () => {
    const r = validate(
      ctxWith([{ name: 'HQ', fields: { site: 'HQ', source_ip: '203.0.113.10', pop_names: 'US-East' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a site', () => {
    const r = validate(ctxWith([{ name: '', fields: { source_ip: '1.2.3.4', pop_names: 'US-East' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a source ip', () => {
    const r = validate(ctxWith([{ name: 'HQ', fields: { site: 'HQ', pop_names: 'US-East' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.source_ip'))).toBe(true)
  })

  it('requires at least one pop name', () => {
    const r = validate(ctxWith([{ name: 'HQ', fields: { site: 'HQ', source_ip: '1.2.3.4' } }]))
    expect(r.errors.some((e) => e.code === 'no_pops')).toBe(true)
  })

  it('rejects an invalid source type', () => {
    const r = validate(ctxWith([{ name: 'HQ', fields: { site: 'HQ', source_ip: '1.2.3.4', pop_names: 'US-East', source_type: 'Robot' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_source_type')).toBe(true)
  })

  it('rejects duplicate sites', () => {
    const r = validate(
      ctxWith([
        { name: 'HQ', fields: { site: 'HQ', source_ip: '1.2.3.4', pop_names: 'US-East' } },
        { name: 'HQ', fields: { site: 'HQ', source_ip: '5.6.7.8', pop_names: 'US-West' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_site')).toBe(true)
  })
})

describe('asNumber', () => {
  it('parses numbers and falls back', () => {
    expect(asNumber(500, 1000)).toBe(500)
    expect(asNumber('250', 1000)).toBe(250)
    expect(asNumber('', 1000)).toBe(1000)
    expect(asNumber(undefined, 1000)).toBe(1000)
  })
})

describe('extractGreTunnelSpecs', () => {
  it('reads fields, pops and defaults', () => {
    const specs = extractGreTunnelSpecs({
      items: [{ id: 'i1', name: 'F', fields: { site: ' HQ ', source_ip: '1.2.3.4', pop_names: 'US-East\nUS-West' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].site).toBe('HQ')
    expect(specs[0].popNames).toEqual(['US-East', 'US-West'])
    expect(specs[0].bandwidth).toBe(1000)
    expect(specs[0].enabled).toBe(true)
  })
})
