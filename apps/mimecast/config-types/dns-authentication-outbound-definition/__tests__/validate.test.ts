import validate, { extractDnsAuthOutboundDefinitionSpecs } from '../validate'
import { definitionEquals, buildPayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('dns-authentication-outbound-definition validate', () => {
  it('accepts a valid definition', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { description: 'Primary DKIM', domain: 'example.com', signDkim: true, keyLength: 2048 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: '', fields: { domain: 'example.com' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.description'))).toBe(true)
  })

  it('requires a domain', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { description: 'D' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.domain'))).toBe(true)
  })

  it('rejects an invalid domain', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { description: 'D', domain: 'not a domain' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_domain')).toBe(true)
  })

  it('rejects an invalid key length', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { description: 'D', domain: 'example.com', keyLength: 4096 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_key_length')).toBe(true)
  })

  it('rejects a duplicate description', () => {
    const r = validate(
      ctxWith([
        { name: 'D', fields: { description: 'Same', domain: 'a.example.com' } },
        { name: 'D2', fields: { description: 'same', domain: 'b.example.com' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_description')).toBe(true)
  })
})

describe('buildPayload / definitionEquals', () => {
  it('never includes a private key in the payload', () => {
    const spec = extractDnsAuthOutboundDefinitionSpecs(ctxWith([{ name: 'D', fields: { description: 'D', domain: 'example.com', keyLength: 2048 } }]).canvas)[0]
    const payload = buildPayload(spec) as Record<string, unknown>
    expect(payload.privateKey).toBeUndefined()
    expect(payload.key).toBeUndefined()
  })

  it('compares a live definition to the desired spec', () => {
    const spec = extractDnsAuthOutboundDefinitionSpecs(
      ctxWith([{ name: 'D', fields: { description: 'D', domain: 'example.com', signDkim: true, keyLength: 2048 } }]).canvas
    )[0]
    const live = { id: 'K1', description: 'D', domain: 'example.com', signDkim: true, keyLength: 2048 }
    expect(definitionEquals(live, spec)).toBe(true)
    const changed = { ...live, keyLength: 1024 }
    expect(definitionEquals(changed, spec)).toBe(false)
  })

  it('ignores selector drift when the selector is not declared', () => {
    const spec = extractDnsAuthOutboundDefinitionSpecs(ctxWith([{ name: 'D', fields: { description: 'D', domain: 'example.com', keyLength: 2048 } }]).canvas)[0]
    const live = { id: 'K1', description: 'D', domain: 'example.com', selector: 'mimecast20260101', signDkim: true, keyLength: 2048 }
    expect(definitionEquals(live, spec)).toBe(true)
  })
})
