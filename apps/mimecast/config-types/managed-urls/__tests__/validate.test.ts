import validate, { desiredIdentity, liveIdentity, extractManagedUrlSpecs } from '../validate'
import { definitionEquals, buildCreatePayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('managed-urls validate', () => {
  it('accepts a valid block URL', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { url: 'https://bad.example.com/x', action: 'block', matchType: 'explicit' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a url', () => {
    const r = validate(ctxWith([{ name: '', fields: { action: 'block' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a url with a fragment', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { url: 'https://x.com/a#frag', action: 'block' } }]))
    expect(r.errors.some((e) => e.code === 'has_fragment')).toBe(true)
  })

  it('rejects an invalid action', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { url: 'x.com', action: 'allow' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('rejects two items targeting the same URL identity', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { url: 'https://x.com/', action: 'block', matchType: 'explicit' } },
        { name: 'B', fields: { url: 'https://x.com', action: 'permit', matchType: 'explicit' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_url')).toBe(true)
  })
})

describe('identity helpers', () => {
  it('matches a desired explicit url to its live form', () => {
    const specs = extractManagedUrlSpecs(
      ctxWith([{ name: 'A', fields: { url: 'HTTPS://Example.com/Path/', action: 'block', matchType: 'explicit' } }]).canvas
    )
    const key = desiredIdentity(specs[0])
    expect(key).toBe('explicit:https://example.com/path')
    expect(liveIdentity({ matchType: 'explicit', scheme: 'https', domain: 'example.com', path: '/path', action: 'block' })).toBe(key)
  })

  it('matches a domain entry on the host', () => {
    const specs = extractManagedUrlSpecs(
      ctxWith([{ name: 'A', fields: { url: 'https://mail.example.com/x', action: 'block', matchType: 'domain' } }]).canvas
    )
    expect(desiredIdentity(specs[0])).toBe('domain:mail.example.com')
    expect(liveIdentity({ matchType: 'domain', domain: 'mail.example.com' })).toBe('domain:mail.example.com')
  })
})

describe('definitionEquals / buildCreatePayload', () => {
  it('detects a changed action as unequal', () => {
    const spec = extractManagedUrlSpecs(
      ctxWith([{ name: 'A', fields: { url: 'https://x.com', action: 'block', matchType: 'explicit' } }]).canvas
    )[0]
    expect(definitionEquals({ action: 'block' }, spec)).toBe(true)
    expect(definitionEquals({ action: 'permit' }, spec)).toBe(false)
    const payload = buildCreatePayload(spec)
    expect(payload.url).toBe('https://x.com')
    expect(payload.action).toBe('block')
    expect(payload.matchType).toBe('explicit')
  })
})
