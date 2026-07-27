import validate, { parseMembers, extractResourceListSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('resource-lists validate', () => {
  it('accepts a valid TAG resource list', () => {
    const r = validate(ctxWith([{ name: 'Prod Tags', fields: { name: 'Prod Tags', resourceListType: 'TAG', members: '[{"key":"env","value":"prod"}]' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { resourceListType: 'TAG', members: '[]' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('rejects an unknown resource list type', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', resourceListType: 'WIDGETS', members: '[]' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects invalid members JSON', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', resourceListType: 'TAG', members: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_members')).toBe(true)
  })

  it('rejects TAG members missing a key', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', resourceListType: 'TAG', members: '[{"value":"x"}]' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_members')).toBe(true)
  })

  it('rejects RESOURCE_GROUP members that are not strings', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', resourceListType: 'RESOURCE_GROUP', members: '[{"key":"x"}]' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_members')).toBe(true)
  })

  it('warns on an empty members list', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', resourceListType: 'TAG', members: '[]' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_members')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', resourceListType: 'TAG', members: '[]' } },
        { name: 'Dup', fields: { name: 'Dup', resourceListType: 'TAG', members: '[]' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseMembers', () => {
  it('parses a JSON array string', () => {
    expect(parseMembers('[1,2]').members).toEqual([1, 2])
  })

  it('flags a non-array JSON value', () => {
    expect(parseMembers('{"a":1}').membersError).toBe('Members must be a JSON array')
  })

  it('treats blank as an empty array', () => {
    expect(parseMembers('  ').members).toEqual([])
  })
})

describe('extractResourceListSpecs', () => {
  it('parses members and trims fields', () => {
    const specs = extractResourceListSpecs({
      items: [{ id: 'i1', name: 'R', fields: { name: ' R ', resourceListType: 'TAG', members: '[{"key":"env"}]' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('R')
    expect(specs[0].members).toEqual([{ key: 'env' }])
  })
})
