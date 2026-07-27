import validate, { extractTriggerSubscriptionSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('trigger-subscriptions validate', () => {
  it('accepts a valid HTTP subscription', () => {
    const r = validate(ctxWith([{ name: 'ar', fields: { name: 'ar', triggerId: 'idn:access-requested', type: 'HTTP', config: '{"url":"https://x"}' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name, triggerId and config', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'HTTP' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].triggerId')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].config')).toBe(true)
  })

  it('rejects an unknown type', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { name: 'x', triggerId: 't', type: 'KAFKA', config: '{}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })
})

describe('extractTriggerSubscriptionSpecs', () => {
  it('defaults type, enabled and deadline', () => {
    const specs = extractTriggerSubscriptionSpecs({
      items: [{ id: 'i1', name: 'x', fields: { name: 'x', triggerId: 't', config: { url: 'u' } } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('HTTP')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].responseDeadline).toBe('PT1H')
    expect(specs[0].configRaw).toBe('{"url":"u"}')
  })
})
