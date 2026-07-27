import validate, { extractCalculatedPropertySpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const base = {
  name: 'DoubleBytes',
  operator: 'MULTIPLY',
  firstOperandType: 'PROPERTY',
  firstOperandValue: 'Bytes',
  secondOperandType: 'STATIC',
  secondOperandValue: '2',
}

describe('calculated-event-properties validate', () => {
  it('accepts a valid calculated property', () => {
    const r = validate(ctxWith([{ name: 'DoubleBytes', fields: { ...base } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { ...base, name: '' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid operator', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { ...base, operator: 'MODULO' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_operator')).toBe(true)
  })

  it('rejects a non-numeric STATIC operand', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { ...base, secondOperandValue: 'abc' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_operand_value')).toBe(true)
  })

  it('rejects a PROPERTY operand with no name', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { ...base, firstOperandValue: '' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })
})

describe('extractCalculatedPropertySpecs', () => {
  it('reads operator and operands from fields', () => {
    const specs = extractCalculatedPropertySpecs({
      items: [{ id: 'i1', name: 'DoubleBytes', fields: { ...base } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].operator).toBe('MULTIPLY')
    expect(specs[0].firstOperand.type).toBe('PROPERTY')
    expect(specs[0].secondOperand.value).toBe('2')
  })
})
