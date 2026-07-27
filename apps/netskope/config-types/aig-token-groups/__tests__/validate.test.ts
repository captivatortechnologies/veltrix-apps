import validate, { extractTokenGroupSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('aig-token-groups validate', () => {
  it('accepts a valid group', () => {
    const r = validate(ctxWith([{ name: 'Prod Tokens', fields: { name: 'Prod Tokens', description: 'x' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a too-long name', () => {
    const r = validate(ctxWith([{ name: 'x'.repeat(101), fields: { name: 'x'.repeat(101) } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
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

describe('extractTokenGroupSpecs', () => {
  it('reads name and description, trimming', () => {
    const specs = extractTokenGroupSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: ' Prod ', description: ' d ' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', name: 'Prod', description: 'd' })
  })
})
