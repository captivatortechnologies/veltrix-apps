import validate, { extractLogSourceSpecs, parseProtocolParameters } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const base = { name: 'Firewall', typeName: 'Linux OS', protocolName: 'Syslog', protocolParameters: '[{"name":"identifier","value":"fw01"}]' }

describe('log-sources validate', () => {
  it('accepts a valid log source', () => {
    const r = validate(ctxWith([{ name: 'Firewall', fields: { ...base } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { ...base, name: '' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a type name and protocol name', () => {
    const r = validate(ctxWith([{ name: 'Firewall', fields: { name: 'Firewall' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].typeName')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].protocolName')).toBe(true)
  })

  it('rejects invalid protocol-parameter JSON', () => {
    const r = validate(ctxWith([{ name: 'Firewall', fields: { ...base, protocolParameters: 'not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_protocol_parameters')).toBe(true)
  })

  it('rejects a credibility out of range', () => {
    const r = validate(ctxWith([{ name: 'Firewall', fields: { ...base, credibility: 42 } }]))
    expect(r.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })

  it('rejects a duplicate name', () => {
    const r = validate(ctxWith([
      { name: 'Firewall', fields: { ...base } },
      { name: 'firewall', fields: { ...base, name: 'firewall' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseProtocolParameters', () => {
  it('parses a JSON array of name/value pairs', () => {
    const { params, error } = parseProtocolParameters('[{"name":"port","value":"514"}]')
    expect(error).toBe(undefined)
    expect(params).toHaveLength(1)
    expect(params[0].name).toBe('port')
    expect(params[0].value).toBe('514')
  })
  it('reports an error for non-array JSON', () => {
    const { error } = parseProtocolParameters('{"name":"x"}')
    expect(typeof error === 'string').toBe(true)
  })
})

describe('extractLogSourceSpecs', () => {
  it('defaults enabled to true and reads names', () => {
    const specs = extractLogSourceSpecs({
      items: [{ id: 'i1', name: 'Firewall', fields: { ...base } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].typeName).toBe('Linux OS')
    expect(specs[0].enabled).toBe(true)
  })
})
