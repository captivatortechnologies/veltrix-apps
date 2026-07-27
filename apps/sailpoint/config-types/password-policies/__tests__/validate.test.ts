import validate, { extractPasswordPolicySpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('password-policies validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(ctxWith([{ name: 'Standard', fields: { name: 'Standard', minLength: 8, maxLength: 100, minNumeric: 1 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { minLength: 8 } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a negative numeric rule', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', minLength: -1 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_number')).toBe(true)
  })

  it('rejects maxLength below minLength', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', minLength: 20, maxLength: 10 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_range')).toBe(true)
  })

  it('allows maxLength of 0 (no maximum)', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', minLength: 20, maxLength: 0 } }]))
    expect(r.valid).toBe(true)
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
})

describe('extractPasswordPolicySpecs', () => {
  it('reads numeric and boolean rule fields with 0/false defaults', () => {
    const specs = extractPasswordPolicySpecs({
      items: [{ id: 'i1', name: 'P', fields: { name: 'P', description: 'd', minLength: 12, useDictionary: true } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('P')
    expect(specs[0].numbers.minLength).toBe(12)
    expect(specs[0].numbers.maxLength).toBe(0)
    expect(specs[0].booleans.useDictionary).toBe(true)
    expect(specs[0].booleans.requireStrongAuthn).toBe(false)
  })

  it('coerces numeric strings', () => {
    const specs = extractPasswordPolicySpecs({
      items: [{ id: 'i1', name: 'P', fields: { name: 'P', minLength: '10' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].numbers.minLength).toBe(10)
  })
})
