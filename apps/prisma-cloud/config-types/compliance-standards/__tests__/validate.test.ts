import validate, { extractComplianceSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('compliance-standards validate', () => {
  it('accepts a valid standard', () => {
    const r = validate(ctxWith([{ name: 'Internal Baseline', fields: { name: 'Internal Baseline', description: 'Our controls' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { description: 'x' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup' } },
        { name: 'Dup', fields: { name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('enforces the name length limit', () => {
    const long = 'x'.repeat(256)
    const r = validate(ctxWith([{ name: long, fields: { name: long } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })
})

describe('extractComplianceSpecs', () => {
  it('reads name and description, trimming', () => {
    const specs = extractComplianceSpecs({
      items: [{ id: 'i1', name: 'Fallback', fields: { name: '  Real  ', description: ' d ' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', name: 'Real', description: 'd' })
  })
})
