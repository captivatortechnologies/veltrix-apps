import validate, { extractBlockedSenderSpecs } from '../validate'
import { definitionEquals, buildPayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('blocked-senders validate', () => {
  it('accepts a valid block-domain policy', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'Block spammy.example', option: 'block_sender', fromType: 'email_domain', fromValue: 'spammy.example', toType: 'everyone' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: '', fields: { option: 'block_sender', fromType: 'everyone', toType: 'everyone' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a from value for a domain block', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', fromType: 'email_domain', toType: 'everyone' } }]))
    expect(r.errors.some((e) => e.code === 'missing_value')).toBe(true)
  })

  it('rejects an invalid option', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', option: 'nope', fromType: 'everyone', toType: 'everyone' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_option')).toBe(true)
  })

  it('rejects duplicate descriptions', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { description: 'Dup', fromType: 'everyone', toType: 'everyone' } },
        { name: 'B', fields: { description: 'Dup', fromType: 'everyone', toType: 'everyone' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_description')).toBe(true)
  })
})

describe('definitionEquals / buildPayload', () => {
  it('builds a nested from/to payload and compares definitions', () => {
    const spec = extractBlockedSenderSpecs(
      ctxWith([{ name: 'P', fields: { description: 'P', option: 'block_sender', fromType: 'email_domain', fromValue: 'x.com', toType: 'everyone' } }]).canvas
    )[0]
    const payload = buildPayload(spec) as { option: string; policy: { from: { type: string; emailDomain?: string } } }
    expect(payload.option).toBe('block_sender')
    expect(payload.policy.from.type).toBe('email_domain')
    expect(payload.policy.from.emailDomain).toBe('x.com')
    expect(definitionEquals({ option: 'block_sender', policy: { from: { type: 'email_domain', emailDomain: 'x.com' }, to: { type: 'everyone' } } }, spec)).toBe(true)
    expect(definitionEquals({ option: 'no_action', policy: { from: { type: 'email_domain', emailDomain: 'x.com' }, to: { type: 'everyone' } } }, spec)).toBe(false)
  })
})
