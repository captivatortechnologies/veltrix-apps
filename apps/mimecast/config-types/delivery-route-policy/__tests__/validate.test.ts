import validate, { extractDeliveryRoutePolicySpecs } from '../validate'
import { definitionEquals, buildPayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('delivery-route-policy validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(
      ctxWith([{ name: 'P', fields: { description: 'Route partner mail', definitionId: 'route-1', fromPart: 'envelope_from', fromType: 'email_domain', fromValue: 'partner.example', toType: 'everyone' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: '', fields: { definitionId: 'route-1' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.description'))).toBe(true)
  })

  it('requires a definitionId', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.definitionId'))).toBe(true)
  })

  it('requires a from value for a domain scope', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', definitionId: 'route-1', fromType: 'email_domain' } }]))
    expect(r.errors.some((e) => e.code === 'missing_value')).toBe(true)
  })
})

describe('buildPayload / definitionEquals', () => {
  it('builds a create/update payload', () => {
    const spec = extractDeliveryRoutePolicySpecs(
      ctxWith([{ name: 'P', fields: { description: 'P', definitionId: 'route-1', fromPart: 'envelope_from', fromType: 'everyone', toType: 'everyone' } }]).canvas
    )[0]
    const payload = buildPayload(spec) as { definitionId: string; from: { type: string }; to: { type: string } }
    expect(payload.definitionId).toBe('route-1')
    expect(payload.from.type).toBe('everyone')
    expect(payload.to.type).toBe('everyone')
  })

  it('compares a live policy to the desired spec', () => {
    const spec = extractDeliveryRoutePolicySpecs(
      ctxWith([{ name: 'P', fields: { description: 'P', definitionId: 'route-1', fromPart: 'envelope_from', fromType: 'everyone', toType: 'everyone' } }]).canvas
    )[0]
    const live = { id: 'DP1', description: 'P', definitionId: 'route-1', fromPart: 'envelope_from', from: { type: 'everyone' }, to: { type: 'everyone' } }
    expect(definitionEquals(live, spec)).toBe(true)
    const changed = { ...live, definitionId: 'route-2' }
    expect(definitionEquals(changed, spec)).toBe(false)
  })
})
