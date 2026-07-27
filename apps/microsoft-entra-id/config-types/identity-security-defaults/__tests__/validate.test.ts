import validate, { extractSecurityDefaultsSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('identity-security-defaults validate', () => {
  it('accepts a disabled policy with no warnings', () => {
    const r = validate(ctxWith([{ fields: { isEnabled: false } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings).toHaveLength(0)
  })

  it('warns when enabling (mutually exclusive with Conditional Access)', () => {
    const r = validate(ctxWith([{ fields: { isEnabled: true } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'mutually_exclusive')).toBe(true)
  })

  it('rejects more than one item', () => {
    const r = validate(ctxWith([{ fields: {} }, { fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('reads isEnabled as a real boolean', () => {
    const specs = extractSecurityDefaultsSpecs({ items: [{ fields: { isEnabled: true } }] } as never)
    expect(specs[0].isEnabled).toBe(true)
  })
})
