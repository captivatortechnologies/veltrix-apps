import validate, { extractTrafficShaperSpecs, asToggle } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-traffic-shapers validate', () => {
  it('accepts a valid shaper', () => {
    const r = validate(ctxWith([{ name: 'Bulk', fields: { name: 'Bulk', guaranteedBandwidth: 100, maximumBandwidth: 1000, bandwidthUnit: 'mbps', priority: 'low' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { bandwidthUnit: 'kbps', priority: 'high' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid bandwidth unit', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', bandwidthUnit: 'tbps', priority: 'high' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_unit')).toBe(true)
  })

  it('rejects an invalid priority', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', bandwidthUnit: 'kbps', priority: 'urgent' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('rejects a negative bandwidth', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', guaranteedBandwidth: -5, bandwidthUnit: 'kbps', priority: 'high' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_bandwidth')).toBe(true)
  })

  it('rejects an invalid diffserv code', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', bandwidthUnit: 'kbps', priority: 'high', diffserv: true, diffservcode: '12' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_diffservcode')).toBe(true)
  })

  it('warns when guaranteed exceeds maximum', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', guaranteedBandwidth: 900, maximumBandwidth: 100, bandwidthUnit: 'kbps', priority: 'high' } }]))
    expect(r.warnings.some((w) => w.code === 'bandwidth_order')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', bandwidthUnit: 'kbps', priority: 'high' } },
        { name: 'Dup', fields: { name: 'Dup', bandwidthUnit: 'kbps', priority: 'high' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('asToggle', () => {
  it('maps booleans to enable/disable', () => {
    expect(asToggle(true)).toBe('enable')
    expect(asToggle(false)).toBe('disable')
    expect(asToggle(undefined)).toBe('disable')
  })
})

describe('extractTrafficShaperSpecs', () => {
  it('parses numbers and toggles', () => {
    const specs = extractTrafficShaperSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', guaranteedBandwidth: '50', perPolicy: true, bandwidthUnit: 'MBPS', priority: 'LOW' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].guaranteedBandwidth).toBe(50)
    expect(specs[0].perPolicy).toBe('enable')
    expect(specs[0].bandwidthUnit).toBe('mbps')
    expect(specs[0].priority).toBe('low')
  })
})
