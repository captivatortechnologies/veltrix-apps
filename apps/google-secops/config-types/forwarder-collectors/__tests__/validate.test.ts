import validate, { extractCollectorSpecs, settingsKeyOf, parseConfig } from '../validate'
import { collectorBody, collectorIdOf } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const CONFIG = JSON.stringify({ logType: 'WINEVTLOG', syslogSettings: { protocol: 'TCP', port: 514 } })

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('forwarder-collectors validate', () => {
  it('accepts a valid collector', () => {
    const r = validate(ctxWith([{ name: 'c1', fields: { forwarderName: 'Prod', displayName: 'syslog-in', config: CONFIG } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a forwarder name, display name and config', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a logType and a settings union in config', () => {
    const r = validate(ctxWith([{ name: 'c1', fields: { forwarderName: 'Prod', displayName: 'x', config: '{}' } }]))
    expect(r.errors.some((e) => e.code === 'missing_log_type')).toBe(true)
    expect(r.errors.some((e) => e.code === 'missing_settings')).toBe(true)
  })

  it('rejects a duplicate collector on the same forwarder', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { forwarderName: 'Prod', displayName: 'dup', config: CONFIG } },
        { name: 'b', fields: { forwarderName: 'Prod', displayName: 'dup', config: CONFIG } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows the same collector name on different forwarders', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { forwarderName: 'Prod', displayName: 'syslog-in', config: CONFIG } },
        { name: 'b', fields: { forwarderName: 'Dev', displayName: 'syslog-in', config: CONFIG } },
      ])
    )
    expect(r.valid).toBe(true)
  })
})

describe('extractCollectorSpecs / collectorBody / helpers', () => {
  it('maps items to specs and pulls the logType out of config', () => {
    const specs = extractCollectorSpecs(ctxWith([{ id: 'i1', name: 'c', fields: { forwarderName: 'Prod', displayName: 'syslog-in', config: CONFIG } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].logType).toBe('WINEVTLOG')
    expect(settingsKeyOf(parseConfig(CONFIG))).toBe('syslogSettings')
  })

  it('builds a create/update body and finds the id tail', () => {
    const specs = extractCollectorSpecs(ctxWith([{ name: 'c', fields: { forwarderName: 'Prod', displayName: 'syslog-in', config: CONFIG } }]).canvas)
    const body = collectorBody(specs[0]) as { displayName: string; config: Record<string, unknown> }
    expect(body.displayName).toBe('syslog-in')
    expect(collectorIdOf('projects/p/.../forwarders/f/collectors/col-2')).toBe('col-2')
  })
})
