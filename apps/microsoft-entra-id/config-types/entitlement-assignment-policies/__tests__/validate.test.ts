import validate, { canonical, parseObject } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('entitlement-assignment-policies validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(
      ctxWith([
        {
          fields: {
            name: 'Standard',
            accessPackageName: 'Sales reps',
            allowedTargetScope: 'allMemberUsers',
            expiration: '{"type":"noExpiration"}',
          },
        },
      ]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name and access package', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.filter((e) => e.code === 'required').length).toBe(2)
  })

  it('rejects an invalid target scope', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', accessPackageName: 'P', allowedTargetScope: 'everyone' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_target_scope')).toBe(true)
  })

  it('rejects invalid settings JSON', () => {
    const r = validate(
      ctxWith([{ fields: { name: 'X', accessPackageName: 'P', requestorSettings: '{bad' } }]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })
})

describe('helpers', () => {
  it('canonicalizes settings independent of key order', () => {
    expect(canonical(parseObject('{"a":1,"b":2}'))).toBe(canonical(parseObject('{"b":2,"a":1}')))
  })
})
