import validate, { extractWebSecurityPolicySpecs, parseUrls, urlIdentity } from '../validate'
import { definitionEquals, buildPayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('web-security-policy validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'Block malware', urls: 'block domain malware.example\nallow url https://trusted.example', fromType: 'everyone', toType: 'everyone' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: '', fields: { urls: 'block domain x.example' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires at least one url entry', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', urls: '' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].urls' && e.code === 'required')).toBe(true)
  })

  it('rejects an invalid url action', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', urls: 'permit domain x.example' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_url_action')).toBe(true)
  })

  it('rejects an invalid url type', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', urls: 'block host x.example' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_url_type')).toBe(true)
  })

  it('requires a from value for a domain scope', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', urls: 'block domain x.example', fromType: 'email_domain', toType: 'everyone' } }]))
    expect(r.errors.some((e) => e.code === 'missing_value')).toBe(true)
  })

  it('rejects a duplicate url entry', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', urls: 'block domain x.example\nblock domain X.example' } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_url')).toBe(true)
  })
})

describe('parseUrls / definitionEquals / buildPayload', () => {
  it('parses the url textarea into entries', () => {
    const urls = parseUrls('block domain evil.example\nallow url https://good.example/tools')
    expect(urls).toHaveLength(2)
    expect(urls[0].action).toBe('block')
    expect(urls[0].type).toBe('domain')
    expect(urls[0].value).toBe('evil.example')
    expect(urlIdentity(urls[1])).toBe('allow:url:https://good.example/tools')
  })

  it('builds a create payload and compares live definitions', () => {
    const spec = extractWebSecurityPolicySpecs(
      ctxWith([{ name: 'P', fields: { description: 'P', enabled: true, urls: 'block domain evil.example', fromType: 'everyone', toType: 'everyone' } }]).canvas
    )[0]
    const payload = buildPayload(spec) as { description: string; urls: Array<{ action: string; type: string; value: string }>; policies: Array<{ enabled: boolean; from: { type: string } }> }
    expect(payload.description).toBe('P')
    expect(payload.urls[0].value).toBe('evil.example')
    expect(payload.policies[0].enabled).toBe(true)
    expect(payload.policies[0].from.type).toBe('everyone')

    const live = { id: 'W1', description: 'P', urls: [{ action: 'block', type: 'domain', value: 'evil.example' }], policies: [{ policy: { enabled: true, from: { type: 'everyone' }, to: { type: 'everyone' } } }] }
    expect(definitionEquals(live, spec)).toBe(true)
    const changed = { id: 'W1', description: 'P', urls: [{ action: 'allow', type: 'domain', value: 'evil.example' }], policies: [{ policy: { enabled: true, from: { type: 'everyone' }, to: { type: 'everyone' } } }] }
    expect(definitionEquals(changed, spec)).toBe(false)
  })
})
