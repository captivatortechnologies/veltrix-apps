import validate, { extractLocalBrokerSpecs, asOptionalNumber } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('npa-local-brokers validate', () => {
  it('accepts a valid broker', () => {
    const r = validate(ctxWith([{ name: 'HQ-LBR', fields: { local_broker_name: 'HQ-LBR', access_via_public_ip: 'ON_PREM' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { access_via_public_ip: 'NONE' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid access mode', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { local_broker_name: 'A', access_via_public_ip: 'ALWAYS' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { local_broker_name: 'Dup' } },
        { name: 'Dup', fields: { local_broker_name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('asOptionalNumber', () => {
  it('parses numbers and treats blank as undefined', () => {
    expect(asOptionalNumber(51.5)).toBe(51.5)
    expect(asOptionalNumber('40.7')).toBe(40.7)
    expect(asOptionalNumber('')).toBe(undefined)
    expect(asOptionalNumber('abc')).toBe(undefined)
  })
})

describe('extractLocalBrokerSpecs', () => {
  it('reads fields, labels and defaults access mode', () => {
    const specs = extractLocalBrokerSpecs({
      items: [{ id: 'i1', name: 'F', fields: { local_broker_name: ' HQ ', labels: 'Prod\nEdge' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('HQ')
    expect(specs[0].accessViaPublicIp).toBe('NONE')
    expect(specs[0].labels).toEqual(['Prod', 'Edge'])
  })
})
