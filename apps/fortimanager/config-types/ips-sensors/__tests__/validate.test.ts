import validate, { extractIpsSensorSpecs, asToggle } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('ips-sensors validate', () => {
  it('accepts a valid sensor with entries', () => {
    const r = validate(ctxWith([{ name: 'Sensor', fields: { name: 'Sensor', scanBotnetConnections: 'block', entries: '[{"id":1,"action":"block"}]' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { entries: '[]' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid botnet action', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', scanBotnetConnections: 'drop' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_botnet_action')).toBe(true)
  })

  it('rejects invalid entries JSON', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', entries: '[bad' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects non-array entries', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', entries: '{"id":1}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json_shape')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup' } },
        { name: 'Dup', fields: { name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('asToggle', () => {
  it('maps checkbox booleans to enable/disable', () => {
    expect(asToggle(true)).toBe('enable')
    expect(asToggle(false)).toBe('disable')
  })
})

describe('extractIpsSensorSpecs', () => {
  it('lowercases and defaults the botnet action', () => {
    const specs = extractIpsSensorSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', scanBotnetConnections: 'MONITOR' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].scanBotnetConnections).toBe('monitor')
  })
})
