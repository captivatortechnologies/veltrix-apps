import validate, { extractAntiSpoofingBypassSpecs } from '../validate'
import { definitionEquals, buildPayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('anti-spoofing-bypass validate', () => {
  it('accepts a valid enable-bypass policy', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'Bypass trusted.example', option: 'enable_bypass', fromType: 'email_domain', fromValue: 'trusted.example', toType: 'everyone' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: '', fields: { option: 'enable_bypass', fromType: 'everyone', toType: 'everyone' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a from value for a domain match', () => {
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

  it('warns on an implausible SPF domain', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', fromType: 'everyone', toType: 'everyone', spfDomains: 'good.example\nnot a domain' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'implausible_domain')).toBe(true)
  })
})

describe('definitionEquals / buildPayload', () => {
  it('builds a nested from/to payload with SPF conditions and compares definitions', () => {
    const spec = extractAntiSpoofingBypassSpecs(
      ctxWith([{ name: 'P', fields: { description: 'P', option: 'enable_bypass', fromType: 'email_domain', fromValue: 'x.com', toType: 'everyone', spfDomains: 'x.com' } }]).canvas
    )[0]
    const payload = buildPayload(spec) as { option: string; policy: { from: { type: string; emailDomain?: string } }; conditions?: { spfDomains: string[] } }
    expect(payload.option).toBe('enable_bypass')
    expect(payload.policy.from.type).toBe('email_domain')
    expect(payload.policy.from.emailDomain).toBe('x.com')
    expect(payload.conditions?.spfDomains).toHaveLength(1)
    expect(definitionEquals({ option: 'enable_bypass', conditions: { spfDomains: ['x.com'] }, policy: { from: { type: 'email_domain', emailDomain: 'x.com' }, to: { type: 'everyone' } } }, spec)).toBe(true)
    expect(definitionEquals({ option: 'disable_bypass', conditions: { spfDomains: ['x.com'] }, policy: { from: { type: 'email_domain', emailDomain: 'x.com' }, to: { type: 'everyone' } } }, spec)).toBe(false)
    expect(definitionEquals({ option: 'enable_bypass', policy: { from: { type: 'email_domain', emailDomain: 'x.com' }, to: { type: 'everyone' } } }, spec)).toBe(false)
  })
})
