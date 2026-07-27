import validate, { BRANDING_FIELDS, extractBrandingSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('organizational-branding validate', () => {
  it('accepts a valid branding item', () => {
    const r = validate(ctxWith([{ fields: { backgroundColor: '#FFFFFF', signInPageText: 'Welcome' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts an all-blank (do-not-manage) item', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(true)
  })

  it('rejects an invalid hex color', () => {
    const r = validate(ctxWith([{ fields: { backgroundColor: 'white' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_color')).toBe(true)
  })

  it('rejects an over-long username hint', () => {
    const r = validate(ctxWith([{ fields: { usernameHintText: 'x'.repeat(65) } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects more than one item', () => {
    const r = validate(ctxWith([{ fields: {} }, { fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('extracts all managed fields', () => {
    const specs = extractBrandingSpecs({ items: [{ fields: { signInPageText: 'Hi' } }] } as never)
    expect(Object.keys(specs[0].values).length).toBe(BRANDING_FIELDS.length)
    expect(specs[0].values.signInPageText).toBe('Hi')
  })
})
