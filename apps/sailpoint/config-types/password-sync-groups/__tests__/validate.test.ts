import validate, { extractPasswordSyncGroupSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('password-sync-groups validate', () => {
  it('accepts a valid group', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G', passwordPolicyId: 'pp1', sourceIds: ['s1'] } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name and password policy', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].passwordPolicyId')).toBe(true)
  })

  it('warns when a group has no sources', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G', passwordPolicyId: 'p' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'no_sources')).toBe(true)
  })
})

describe('extractPasswordSyncGroupSpecs', () => {
  it('de-dupes source ids', () => {
    const specs = extractPasswordSyncGroupSpecs({
      items: [{ id: 'i1', name: 'G', fields: { name: 'G', passwordPolicyId: 'p', sourceIds: ['s1', 's1', 's2'] } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].sourceIds).toEqual(['s1', 's2'])
  })
})
