import validate, { extractSourceAppSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('source-apps validate', () => {
  it('accepts a valid source app', () => {
    const r = validate(ctxWith([{ name: 'Payroll', fields: { name: 'Payroll', accountSourceId: 'src1' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name and account source', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].accountSourceId')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', accountSourceId: 's' } },
        { name: 'Dup', fields: { name: 'Dup', accountSourceId: 's' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractSourceAppSpecs', () => {
  it('reads fields', () => {
    const specs = extractSourceAppSpecs({
      items: [{ id: 'i1', name: 'A', fields: { name: 'A', accountSourceId: 's', matchAllAccounts: true } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].accountSourceId).toBe('s')
    expect(specs[0].matchAllAccounts).toBe(true)
  })
})
