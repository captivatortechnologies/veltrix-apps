import validate, { extractAssetGroupSpecs } from '../validate'
import { buildBody, definitionEquals } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('asset-groups validate', () => {
  it('accepts a valid dynamic group', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'Windows', description: 'd', memberType: 'DEVICE', query: 'os.equals:WINDOWS' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name and description', () => {
    const r = validate(ctxWith([{ name: '', fields: { memberType: 'DEVICE' } }]))
    expect(r.errors.filter((e) => e.code === 'required').length >= 2).toBe(true)
  })

  it('rejects an invalid member type', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G', description: 'd', memberType: 'PERSON', query: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_member_type')).toBe(true)
  })

  it('rejects a non-integer policy id', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G', description: 'd', memberType: 'DEVICE', query: 'x', policyId: 'abc' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_policy_id')).toBe(true)
  })

  it('warns on a group with no query and no policy', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G', description: 'd', memberType: 'DEVICE' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_group')).toBe(true)
  })

  it('flags a duplicate group name', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { name: 'Dup', description: 'd', memberType: 'DEVICE', query: 'x' } },
        { name: 'B', fields: { name: 'dup', description: 'd', memberType: 'DEVICE', query: 'y' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('buildBody / definitionEquals', () => {
  it('builds a group body with a numeric policy id', () => {
    const spec = extractAssetGroupSpecs(
      ctxWith([{ name: 'G', fields: { name: 'G', description: 'd', memberType: 'DEVICE', query: 'os.equals:WINDOWS', policyId: '42' } }]).canvas
    )[0]
    const body = buildBody(spec) as { name: string; member_type: string; query: string; policy_id: number }
    expect(body.name).toBe('G')
    expect(body.member_type).toBe('DEVICE')
    expect(body.query).toBe('os.equals:WINDOWS')
    expect(body.policy_id).toBe(42)
    expect(definitionEquals({ description: 'd', query: 'os.equals:WINDOWS', policy_id: 42 }, spec)).toBe(true)
    expect(definitionEquals({ description: 'd', query: 'os.equals:LINUX', policy_id: 42 }, spec)).toBe(false)
  })
})
