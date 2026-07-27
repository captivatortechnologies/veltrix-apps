import validate, { extractAddressAlterationSpecs } from '../validate'
import { definitionEquals, buildPayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('address-alteration validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'Alter trusted.example', addressAlterationSetId: 'SET123', fromPart: 'envelope_from', fromType: 'email_domain', fromValue: 'trusted.example', toType: 'everyone' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: '', fields: { addressAlterationSetId: 'SET123', fromType: 'everyone', toType: 'everyone' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires an address alteration set id', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', fromType: 'everyone', toType: 'everyone' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].addressAlterationSetId' && e.code === 'required')).toBe(true)
  })

  it('requires a from value for a domain match', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', addressAlterationSetId: 'SET123', fromType: 'email_domain', toType: 'everyone' } }]))
    expect(r.errors.some((e) => e.code === 'missing_value')).toBe(true)
  })

  it('rejects an invalid from part', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', addressAlterationSetId: 'SET123', fromPart: 'nope', fromType: 'everyone', toType: 'everyone' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_from_part')).toBe(true)
  })

  it('rejects duplicate descriptions', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { description: 'Dup', addressAlterationSetId: 'SET123', fromType: 'everyone', toType: 'everyone' } },
        { name: 'B', fields: { description: 'Dup', addressAlterationSetId: 'SET123', fromType: 'everyone', toType: 'everyone' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_description')).toBe(true)
  })
})

describe('definitionEquals / buildPayload', () => {
  it('builds a nested from/to payload with a set id and compares definitions', () => {
    const spec = extractAddressAlterationSpecs(
      ctxWith([{ name: 'P', fields: { description: 'P', addressAlterationSetId: 'SET123', fromPart: 'envelope_from', fromType: 'email_domain', fromValue: 'x.com', toType: 'everyone' } }]).canvas
    )[0]
    const payload = buildPayload(spec) as { addressAlterationSetId: string; policy: { fromPart: string; enabled: boolean; from: { type: string; emailDomain?: string } } }
    expect(payload.addressAlterationSetId).toBe('SET123')
    expect(payload.policy.fromPart).toBe('envelope_from')
    expect(payload.policy.enabled).toBe(true)
    expect(payload.policy.from.type).toBe('email_domain')
    expect(payload.policy.from.emailDomain).toBe('x.com')
    expect(definitionEquals({ addressAlterationSetId: 'SET123', policy: { fromPart: 'envelope_from', enabled: true, from: { type: 'email_domain', emailDomain: 'x.com' }, to: { type: 'everyone' } } }, spec)).toBe(true)
    expect(definitionEquals({ addressAlterationSetId: 'OTHER', policy: { fromPart: 'envelope_from', enabled: true, from: { type: 'email_domain', emailDomain: 'x.com' }, to: { type: 'everyone' } } }, spec)).toBe(false)
    expect(definitionEquals({ addressAlterationSetId: 'SET123', policy: { fromPart: 'header_from', enabled: true, from: { type: 'email_domain', emailDomain: 'x.com' }, to: { type: 'everyone' } } }, spec)).toBe(false)
  })
})
