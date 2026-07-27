import validate, { canonicalSetList, parseArray, stripConditionSet } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('permission-grant-policies validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(
      ctxWith([{ fields: { id: 'low-risk', displayName: 'Low risk', includes: '[]', excludes: '[]' } }]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires an id and display name', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a reserved microsoft- id', () => {
    const r = validate(ctxWith([{ fields: { id: 'microsoft-thing', displayName: 'X' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'reserved_id')).toBe(true)
  })

  it('rejects an invalid id shape', () => {
    const r = validate(ctxWith([{ fields: { id: 'Not Valid', displayName: 'X' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_id')).toBe(true)
  })

  it('rejects invalid includes JSON', () => {
    const r = validate(ctxWith([{ fields: { id: 'p', displayName: 'X', includes: '{not array' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })
})

describe('condition-set helpers', () => {
  it('strips id and @odata metadata', () => {
    const stripped = stripConditionSet({ id: 'x', '@odata.type': 't', permissionType: 'delegated' })
    expect(stripped).toEqual({ permissionType: 'delegated' })
  })

  it('compares sets independent of order and server ids', () => {
    const a = [
      { id: '1', permissionType: 'delegated' },
      { id: '2', permissionType: 'application' },
    ]
    const b = [{ permissionType: 'application' }, { permissionType: 'delegated' }]
    expect(canonicalSetList(a)).toBe(canonicalSetList(b))
  })

  it('parses arrays and rejects objects', () => {
    expect(parseArray('[]')).toEqual([])
    expect(parseArray('{}')).toBe(null)
  })
})
