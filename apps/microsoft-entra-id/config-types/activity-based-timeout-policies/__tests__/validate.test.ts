import validate, { canonicalDefinition, parseDefinitionObject } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const VALID_DEF =
  '{"ActivityBasedTimeoutPolicy":{"Version":1,"ApplicationPolicies":[{"ApplicationId":"default","WebSessionIdleTimeout":"01:00:00"}]}}'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('activity-based-timeout validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(ctxWith([{ name: 'Idle', fields: { name: 'Idle', definition: VALID_DEF } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a definition', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', definition: '' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects invalid JSON', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', definition: '{not json' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects two organization defaults', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { name: 'A', definition: VALID_DEF, isOrganizationDefault: true } },
        { name: 'B', fields: { name: 'B', definition: VALID_DEF, isOrganizationDefault: true } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'multiple_org_defaults')).toBe(true)
  })
})

describe('definition helpers', () => {
  it('parses a JSON object and rejects arrays', () => {
    expect(parseDefinitionObject('{"a":1}') !== null).toBe(true)
    expect(parseDefinitionObject('[1,2]')).toBe(null)
  })

  it('canonicalizes equal objects regardless of key order', () => {
    expect(canonicalDefinition('{"a":1,"b":2}')).toBe(canonicalDefinition('{"b":2,"a":1}'))
  })
})
