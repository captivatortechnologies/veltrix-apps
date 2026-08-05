import validate, { extractGreylistingSpecs } from '../validate'
import { definitionEquals, buildPayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('greylisting validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'Greylist externals', option: 'apply', fromType: 'external_addresses' } }]))
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
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', option: 'quarantine' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_option')).toBe(true)
  })

  it('requires a from value for an email domain scope', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { description: 'P', fromType: 'email_domain' } }]))
    expect(r.errors.some((e) => e.code === 'missing_value')).toBe(true)
  })
})

describe('buildPayload / definitionEquals', () => {
  it('builds a create/update payload', () => {
    const spec = extractGreylistingSpecs(ctxWith([{ name: 'P', fields: { description: 'P', option: 'apply', fromType: 'external_addresses' } }]).canvas)[0]
    const payload = buildPayload(spec) as { description: string; option: string; from: { type: string } }
    expect(payload.description).toBe('P')
    expect(payload.option).toBe('apply')
    expect(payload.from.type).toBe('external_addresses')
  })

  it('compares a live policy to the desired spec', () => {
    const spec = extractGreylistingSpecs(ctxWith([{ name: 'P', fields: { description: 'P', option: 'apply', fromType: 'everyone' } }]).canvas)[0]
    const live = { id: 'G1', description: 'P', option: 'apply', from: { type: 'everyone' } }
    expect(definitionEquals(live, spec)).toBe(true)
    const changed = { ...live, option: 'no_action' }
    expect(definitionEquals(changed, spec)).toBe(false)
  })
})
