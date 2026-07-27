import validate, { extractPerIpShaperSpecs, asToggle } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-per-ip-shapers validate', () => {
  it('accepts a valid per-IP shaper', () => {
    const r = validate(ctxWith([{ name: 'PerHost', fields: { name: 'PerHost', maxBandwidth: 2000, bandwidthUnit: 'kbps', maxConcurrentSession: 100 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { bandwidthUnit: 'kbps' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid bandwidth unit', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', bandwidthUnit: 'tbps' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_unit')).toBe(true)
  })

  it('rejects a negative session limit', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', bandwidthUnit: 'kbps', maxConcurrentSession: -1 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_number')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', bandwidthUnit: 'kbps' } },
        { name: 'Dup', fields: { name: 'Dup', bandwidthUnit: 'kbps' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('asToggle', () => {
  it('maps booleans to enable/disable', () => {
    expect(asToggle(true)).toBe('enable')
    expect(asToggle(false)).toBe('disable')
  })
})

describe('extractPerIpShaperSpecs', () => {
  it('parses numeric fields', () => {
    const specs = extractPerIpShaperSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', maxBandwidth: '500', bandwidthUnit: 'MBPS', diffservForward: true } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].maxBandwidth).toBe(500)
    expect(specs[0].bandwidthUnit).toBe('mbps')
    expect(specs[0].diffservForward).toBe('enable')
  })
})
