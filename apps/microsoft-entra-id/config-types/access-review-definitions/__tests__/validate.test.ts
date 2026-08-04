import validate, { canonical } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const SETTINGS = '{"instanceDurationInDays":7}'
const GROUP_ID = '11111111-1111-1111-1111-111111111111'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('access-review-definitions validate', () => {
  it('accepts a valid groupMembership-scoped definition (the default scopeType)', () => {
    const r = validate(
      ctxWith([{ fields: { name: 'Quarterly', scopeType: 'groupMembership', scopeGroupId: GROUP_ID, settings: SETTINGS } }]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name and settings', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
    expect(r.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('requires the scope-defining field for each non-custom scopeType', () => {
    for (const scopeType of ['groupMembership', 'directoryRole', 'accessPackageAssignments', 'applicationAccess']) {
      const r = validate(ctxWith([{ fields: { name: `X-${scopeType}`, scopeType, settings: SETTINGS } }]))
      expect(r.errors.some((e) => e.code === 'required')).toBe(true)
    }
  })

  it('rejects an unrecognized scopeType', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', scopeType: 'everything', settings: SETTINGS } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_scope_type')).toBe(true)
  })

  it('custom scopeType requires scopeCustomJson to be a valid JSON object', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', scopeType: 'custom', settings: SETTINGS } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_scope')).toBe(true)
  })

  it('accepts a custom scopeType with valid scopeCustomJson', () => {
    const r = validate(
      ctxWith([
        {
          fields: {
            name: 'X',
            scopeType: 'custom',
            scopeCustomJson: '{"@odata.type":"#microsoft.graph.accessReviewQueryScope","query":"/groups/x/members","queryType":"MicrosoftGraph"}',
            settings: SETTINGS,
          },
        },
      ]),
    )
    expect(r.valid).toBe(true)
  })

  it('rejects invalid reviewersCustomJson / fallbackReviewersCustomJson (must be JSON arrays)', () => {
    const r = validate(
      ctxWith([
        {
          fields: {
            name: 'X',
            scopeType: 'groupMembership',
            scopeGroupId: GROUP_ID,
            settings: SETTINGS,
            reviewersCustomJson: '{"not":"an array"}',
            fallbackReviewersCustomJson: 'not json',
          },
        },
      ]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.filter((e) => e.code === 'invalid_json')).toHaveLength(2)
  })

  it('accepts an empty reviewers configuration (self-review)', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', scopeType: 'groupMembership', scopeGroupId: GROUP_ID, settings: SETTINGS } }]))
    expect(r.valid).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { fields: { name: 'Dup', scopeType: 'groupMembership', scopeGroupId: GROUP_ID, settings: SETTINGS } },
        { fields: { name: 'Dup', scopeType: 'groupMembership', scopeGroupId: GROUP_ID, settings: SETTINGS } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('helpers', () => {
  it('canonicalizes objects independent of key order', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }))
  })
})
