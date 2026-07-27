import validate, { parseFeatures, extractPermissionGroupSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const FEATURES = '[{"featureName":"policiesInventory","operations":{"read":true,"update":true}}]'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('permission-groups validate', () => {
  it('accepts a valid custom permission group', () => {
    const r = validate(ctxWith([{ name: 'Auditors', fields: { name: 'Auditors', features: FEATURES } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { features: FEATURES } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires at least one feature', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', features: '[]' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.features'))).toBe(true)
  })

  it('rejects invalid features JSON', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', features: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_features')).toBe(true)
  })

  it('rejects features missing a featureName', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', features: '[{"operations":{"read":true}}]' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_features')).toBe(true)
  })

  it('rejects a non-custom permission group type', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', permissionGroupType: 'Default', features: FEATURES } }]))
    expect(r.errors.some((e) => e.code === 'protected_type')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', features: FEATURES } },
        { name: 'Dup', fields: { name: 'Dup', features: FEATURES } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseFeatures', () => {
  it('parses a JSON array string', () => {
    expect(parseFeatures('[{"featureName":"x","operations":{}}]').features).toHaveLength(1)
  })

  it('flags a non-array JSON value', () => {
    expect(parseFeatures('{"a":1}').featuresError).toBe('Features must be a JSON array')
  })
})

describe('extractPermissionGroupSpecs', () => {
  it('defaults the type to Custom and parses booleans', () => {
    const specs = extractPermissionGroupSpecs({
      items: [{ id: 'i1', name: 'R', fields: { name: 'R', acceptAccountGroups: true, features: FEATURES } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].permissionGroupType).toBe('Custom')
    expect(specs[0].acceptAccountGroups).toBe(true)
  })
})
