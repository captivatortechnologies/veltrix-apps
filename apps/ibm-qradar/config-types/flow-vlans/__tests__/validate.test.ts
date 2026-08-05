import validate, { vlanKey, extractFlowVlanSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('flow-vlans validate', () => {
  it('accepts a valid pair', () => {
    const r = validate(ctxWith([{ name: 'Customer A', fields: { label: 'Customer A', enterpriseVlanId: 10, customerVlanId: 200 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a label', () => {
    const r = validate(ctxWith([{ name: '', fields: { customerVlanId: 200 } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a customer VLAN id of 0', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { label: 'A', customerVlanId: 0 } }]))
    expect(r.errors.some((e) => e.field.endsWith('.customerVlanId') && e.code === 'out_of_range')).toBe(true)
  })

  it('rejects an enterprise VLAN id over 4095', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { label: 'A', enterpriseVlanId: 5000, customerVlanId: 10 } }]))
    expect(r.errors.some((e) => e.field.endsWith('.enterpriseVlanId') && e.code === 'out_of_range')).toBe(true)
  })

  it('rejects a duplicate label', () => {
    const r = validate(ctxWith([
      { name: 'A', fields: { label: 'A', customerVlanId: 10 } },
      { name: 'a', fields: { label: 'a', customerVlanId: 20 } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_label')).toBe(true)
  })

  it('rejects a duplicate VLAN pair', () => {
    const r = validate(ctxWith([
      { name: 'A', fields: { label: 'A', enterpriseVlanId: 1, customerVlanId: 10 } },
      { name: 'B', fields: { label: 'B', enterpriseVlanId: 1, customerVlanId: 10 } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_pair')).toBe(true)
  })
})

describe('vlanKey', () => {
  it('joins enterprise and customer ids', () => {
    expect(vlanKey({ enterpriseVlanId: 1, customerVlanId: 10 })).toBe('1:10')
  })
})

describe('extractFlowVlanSpecs', () => {
  it('defaults enterpriseVlanId to 0', () => {
    const specs = extractFlowVlanSpecs({
      items: [{ id: 'i1', name: 'A', fields: { label: 'A', customerVlanId: 10 } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].enterpriseVlanId).toBe(0)
    expect(specs[0].customerVlanId).toBe(10)
  })
})
