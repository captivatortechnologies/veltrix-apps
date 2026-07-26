import validate, { splitPorts, extractServiceSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-services validate', () => {
  it('accepts a valid TCP service', () => {
    const r = validate(ctxWith([{ name: 'HTTPS', fields: { name: 'HTTPS', protocol: 'TCP/UDP/SCTP', tcpPortrange: '443' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a source:dest port range', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', protocol: 'TCP/UDP/SCTP', tcpPortrange: '443:1024-65535 8080-8090' } }]))
    expect(r.valid).toBe(true)
  })

  it('accepts an IP service with protocol number', () => {
    const r = validate(ctxWith([{ name: 'GRE', fields: { name: 'GRE', protocol: 'IP', protocolNumber: '47' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires ports for a TCP/UDP/SCTP service', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { name: 'X', protocol: 'TCP/UDP/SCTP' } }]))
    expect(r.errors.some((e) => e.code === 'missing_ports')).toBe(true)
  })

  it('rejects an invalid port range', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { name: 'X', protocol: 'TCP/UDP/SCTP', tcpPortrange: 'abc' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_port_range')).toBe(true)
  })

  it('requires a protocol number for IP', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { name: 'X', protocol: 'IP' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_protocol_number')).toBe(true)
  })

  it('rejects an invalid protocol', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { name: 'X', protocol: 'HTTP' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_protocol')).toBe(true)
  })

  it('requires a name and rejects duplicates', () => {
    const r = validate(
      ctxWith([
        { name: '', fields: { protocol: 'TCP/UDP/SCTP', tcpPortrange: '80' } },
        { name: 'Dup', fields: { name: 'Dup', protocol: 'TCP/UDP/SCTP', tcpPortrange: '80' } },
        { name: 'Dup', fields: { name: 'Dup', protocol: 'TCP/UDP/SCTP', tcpPortrange: '80' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitPorts', () => {
  it('splits on whitespace and commas', () => {
    expect(splitPorts('80 443, 8080-8090')).toEqual(['80', '443', '8080-8090'])
    expect(splitPorts('')).toEqual([])
  })
})

describe('extractServiceSpecs', () => {
  it('defaults protocol to TCP/UDP/SCTP', () => {
    const specs = extractServiceSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', tcpPortrange: '80' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].protocol).toBe('TCP/UDP/SCTP')
  })
})
