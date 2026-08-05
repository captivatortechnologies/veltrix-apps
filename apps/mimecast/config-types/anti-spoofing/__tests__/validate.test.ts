import validate, { extractAntiSpoofingSpecs } from '../validate'
import { definitionEquals, buildPayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('anti-spoofing validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(
      ctxWith([{ name: 'P', fields: { description: 'Enforce spoofing', option: 'apply', fromPart: 'envelope_from', fromType: 'everyone', toType: 'everyone' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: '', fields: { option: 'apply' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate description', () => {
    const r = validate(
      ctxWith([
        { name: 'P', fields: { description: 'Same' } },
        { name: 'P2', fields: { description: 'same' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_description')).toBe(true)
  })

  it('rejects an invalid option', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', option: 'block' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_option')).toBe(true)
  })

  it('rejects an invalid fromPart', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', fromPart: 'body' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_from_part')).toBe(true)
  })

  it('requires a from value for a domain scope', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', fromType: 'email_domain' } }]))
    expect(r.errors.some((e) => e.code === 'missing_value' && e.field === 'items[0].fromValue')).toBe(true)
  })

  it('requires a to value for a profile group scope', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', toType: 'profile_group' } }]))
    expect(r.errors.some((e) => e.code === 'missing_value' && e.field === 'items[0].toValue')).toBe(true)
  })
})

describe('buildPayload / definitionEquals', () => {
  it('builds a create/update payload', () => {
    const spec = extractAntiSpoofingSpecs(
      ctxWith([
        {
          name: 'P',
          fields: {
            description: 'P',
            option: 'apply',
            fromPart: 'envelope_from',
            fromType: 'email_domain',
            fromValue: 'example.com',
            toType: 'everyone',
            sourceIPs: '10.0.0.0/8\n192.168.1.1',
          },
        },
      ]).canvas
    )[0]
    const payload = buildPayload(spec) as {
      description: string
      option: string
      from: { type: string; domain?: string }
      to: { type: string }
      sourceIPs?: string[]
    }
    expect(payload.description).toBe('P')
    expect(payload.option).toBe('apply')
    expect(payload.from.type).toBe('email_domain')
    expect(payload.from.domain).toBe('example.com')
    expect(payload.to.type).toBe('everyone')
    expect(payload.sourceIPs).toEqual(['10.0.0.0/8', '192.168.1.1'])
  })

  it('compares a live policy to the desired spec', () => {
    const spec = extractAntiSpoofingSpecs(
      ctxWith([{ name: 'P', fields: { description: 'P', option: 'apply', fromPart: 'envelope_from', fromType: 'everyone', toType: 'everyone' } }]).canvas
    )[0]
    const live = {
      id: 'A1',
      description: 'P',
      option: 'apply',
      fromPart: 'envelope_from',
      from: { type: 'everyone' },
      to: { type: 'everyone' },
      override: false,
      bidirectional: false,
    }
    expect(definitionEquals(live, spec)).toBe(true)
    const changed = { ...live, option: 'no_action' }
    expect(definitionEquals(changed, spec)).toBe(false)
  })
})
