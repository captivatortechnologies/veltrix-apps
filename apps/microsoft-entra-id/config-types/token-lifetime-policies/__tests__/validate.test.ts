import validate, { canonicalDefinition, parseDefinitionObject } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const VALID_DEF = '{"TokenLifetimePolicy":{"Version":1,"AccessTokenLifetime":"8:00:00"}}'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('token-lifetime validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(ctxWith([{ name: 'Short tokens', fields: { name: 'Short tokens', definition: VALID_DEF } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { definition: VALID_DEF } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
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

  it('warns when the root key is missing', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', definition: '{"Other":1}' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'unexpected_definition')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', definition: VALID_DEF } },
        { name: 'Dup', fields: { name: 'Dup', definition: VALID_DEF } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
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
