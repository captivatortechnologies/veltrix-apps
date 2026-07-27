import validate, { splitEntries, extractPrivateAppSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('private-apps validate', () => {
  it('accepts a valid private app', () => {
    const r = validate(
      ctxWith([{ name: 'CRM', fields: { app_name: 'CRM', host: 'crm.corp.example.com', tcp_ports: '443', publishers: 'DC1' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires an app name', () => {
    const r = validate(ctxWith([{ name: '', fields: { host: 'a.com', tcp_ports: '443' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a host', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { app_name: 'A', tcp_ports: '443' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.host'))).toBe(true)
  })

  it('requires at least one port', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { app_name: 'A', host: 'a.com' } }]))
    expect(r.errors.some((e) => e.code === 'no_protocol')).toBe(true)
  })

  it('rejects an invalid port', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { app_name: 'A', host: 'a.com', tcp_ports: '99999999' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('warns when no publishers assigned', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { app_name: 'A', host: 'a.com', tcp_ports: '443' } }]))
    expect(r.warnings.some((w) => w.code === 'no_publishers')).toBe(true)
  })

  it('rejects duplicate app names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { app_name: 'Dup', host: 'a.com', tcp_ports: '443' } },
        { name: 'Dup', fields: { app_name: 'Dup', host: 'b.com', udp_ports: '53' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitEntries', () => {
  it('splits arrays and delimited strings, trimming', () => {
    expect(splitEntries(['80', ' 443 '])).toEqual(['80', '443'])
    expect(splitEntries('80\n443, 8080')).toEqual(['80', '443', '8080'])
    expect(splitEntries('')).toEqual([])
  })
})

describe('extractPrivateAppSpecs', () => {
  it('reads fields, ports and booleans', () => {
    const specs = extractPrivateAppSpecs({
      items: [
        {
          id: 'i1',
          name: 'F',
          fields: { app_name: ' CRM ', host: ' crm.example.com ', tcp_ports: '443,8080', udp_ports: '53', publishers: 'DC1\nDC2', clientless_access: true },
        },
      ],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('CRM')
    expect(specs[0].host).toBe('crm.example.com')
    expect(specs[0].tcpPorts).toEqual(['443', '8080'])
    expect(specs[0].udpPorts).toEqual(['53'])
    expect(specs[0].publishers).toEqual(['DC1', 'DC2'])
    expect(specs[0].clientlessAccess).toBe(true)
    expect(specs[0].usePublisherDns).toBe(false)
  })
})
