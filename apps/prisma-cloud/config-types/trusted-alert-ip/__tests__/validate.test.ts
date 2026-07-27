import validate, { parseCidrs, extractTrustedAlertIpSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('trusted-alert-ip validate', () => {
  it('accepts a valid trusted alert IP list', () => {
    const r = validate(ctxWith([{ name: 'Office', fields: { name: 'Office', cidrs: '[{"cidr":"203.0.113.0/24","description":"hq"}]' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts plain CIDR strings', () => {
    const r = validate(ctxWith([{ name: 'Office', fields: { name: 'Office', cidrs: '["10.0.0.0/8"]' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { cidrs: '["10.0.0.0/8"]' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires at least one CIDR', () => {
    const r = validate(ctxWith([{ name: 'Office', fields: { name: 'Office', cidrs: '[]' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.cidrs'))).toBe(true)
  })

  it('rejects an invalid CIDR', () => {
    const r = validate(ctxWith([{ name: 'Office', fields: { name: 'Office', cidrs: '["not-an-ip"]' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('rejects invalid cidrs JSON', () => {
    const r = validate(ctxWith([{ name: 'Office', fields: { name: 'Office', cidrs: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cidrs')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', cidrs: '["10.0.0.0/8"]' } },
        { name: 'Dup', fields: { name: 'Dup', cidrs: '["10.0.0.0/8"]' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseCidrs', () => {
  it('normalizes object entries', () => {
    expect(parseCidrs('[{"cidr":"10.0.0.0/8","description":"x"}]').cidrs).toEqual([{ cidr: '10.0.0.0/8', description: 'x' }])
  })

  it('normalizes string entries', () => {
    expect(parseCidrs('["10.0.0.0/8"]').cidrs).toEqual([{ cidr: '10.0.0.0/8' }])
  })

  it('flags a non-array JSON value', () => {
    expect(parseCidrs('{"a":1}').cidrsError).toBe('CIDRs must be a JSON array')
  })
})

describe('extractTrustedAlertIpSpecs', () => {
  it('parses the cidrs array', () => {
    const specs = extractTrustedAlertIpSpecs({
      items: [{ id: 'i1', name: 'Office', fields: { name: 'Office', cidrs: '["10.0.0.0/8","192.168.0.0/16"]' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].cidrs).toHaveLength(2)
  })
})
