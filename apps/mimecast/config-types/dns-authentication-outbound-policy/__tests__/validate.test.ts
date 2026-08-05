import validate, { extractDnsAuthOutboundPolicySpecs } from '../validate'
import { definitionEquals, buildPayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('dns-authentication-outbound-policy validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(
      ctxWith([{ name: 'P', fields: { description: 'Sign outbound mail', definitionId: 'dkim-1', fromPart: 'envelope_from', fromType: 'everyone', toType: 'everyone' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: '', fields: { definitionId: 'dkim-1' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.description'))).toBe(true)
  })

  it('requires a definitionId', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.definitionId'))).toBe(true)
  })

  it('requires a from value for an individual email address scope', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', definitionId: 'dkim-1', fromType: 'individual_email_address' } }]))
    expect(r.errors.some((e) => e.code === 'missing_value')).toBe(true)
  })
})

describe('buildPayload / definitionEquals', () => {
  it('builds a create/update payload', () => {
    const spec = extractDnsAuthOutboundPolicySpecs(
      ctxWith([{ name: 'P', fields: { description: 'P', definitionId: 'dkim-1', fromPart: 'envelope_from', fromType: 'everyone', toType: 'everyone' } }]).canvas
    )[0]
    const payload = buildPayload(spec) as { definitionId: string; from: { type: string }; to: { type: string } }
    expect(payload.definitionId).toBe('dkim-1')
    expect(payload.from.type).toBe('everyone')
    expect(payload.to.type).toBe('everyone')
  })

  it('compares a live policy to the desired spec', () => {
    const spec = extractDnsAuthOutboundPolicySpecs(
      ctxWith([{ name: 'P', fields: { description: 'P', definitionId: 'dkim-1', fromPart: 'envelope_from', fromType: 'everyone', toType: 'everyone' } }]).canvas
    )[0]
    const live = { id: 'DP1', description: 'P', definitionId: 'dkim-1', fromPart: 'envelope_from', from: { type: 'everyone' }, to: { type: 'everyone' } }
    expect(definitionEquals(live, spec)).toBe(true)
    const changed = { ...live, definitionId: 'dkim-2' }
    expect(definitionEquals(changed, spec)).toBe(false)
  })
})
