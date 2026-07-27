import validate, { normalizeCombo, combinationsEqual, isCustomPolicy } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('authentication-strength validate', () => {
  it('accepts a valid strength', () => {
    const r = validate(ctxWith([{ name: 'FIDO2 only', fields: { name: 'FIDO2 only', allowedCombinations: 'fido2' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a multi-mode combination', () => {
    const r = validate(ctxWith([{ name: 'Pw+SMS', fields: { name: 'Pw+SMS', allowedCombinations: 'password,sms' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { allowedCombinations: 'fido2' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires at least one combination', () => {
    const r = validate(ctxWith([{ name: 'Empty', fields: { name: 'Empty', allowedCombinations: '' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'missing_combinations')).toBe(true)
  })

  it('rejects an unknown method mode', () => {
    const r = validate(ctxWith([{ name: 'Bad', fields: { name: 'Bad', allowedCombinations: 'magic' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_method_mode')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', allowedCombinations: 'fido2' } },
        { name: 'Dup', fields: { name: 'Dup', allowedCombinations: 'fido2' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('combination helpers', () => {
  it('normalizes combinations order-insensitively', () => {
    expect(normalizeCombo('password, sms')).toBe('password,sms')
    expect(normalizeCombo('sms,password')).toBe('password,sms')
  })

  it('compares combination collections as sets', () => {
    expect(combinationsEqual(['password,sms'], ['sms, password'])).toBe(true)
    expect(combinationsEqual(['fido2'], ['fido2', 'sms'])).toBe(false)
  })

  it('treats only custom policies as manageable', () => {
    expect(isCustomPolicy({ policyType: 'custom' })).toBe(true)
    expect(isCustomPolicy({ policyType: 'builtIn' })).toBe(false)
  })
})
