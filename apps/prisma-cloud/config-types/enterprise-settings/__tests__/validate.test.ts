import validate, { buildOverlay, extractEnterpriseSettingsSpecs, parseDefaultPolicies } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('enterprise-settings validate', () => {
  it('accepts a valid partial settings item', () => {
    const r = validate(ctxWith([{ fields: { sessionTimeout: '60', requireAlertDismissalNote: 'true' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('rejects a negative number', () => {
    const r = validate(ctxWith([{ fields: { sessionTimeout: '-5' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_number')).toBe(true)
  })

  it('rejects invalid default policies JSON', () => {
    const r = validate(ctxWith([{ fields: { defaultPoliciesEnabled: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_default_policies')).toBe(true)
  })

  it('warns when nothing is set', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty')).toBe(true)
  })

  it('warns when more than one item is declared', () => {
    const r = validate(ctxWith([{ fields: { sessionTimeout: '30' } }, { fields: { sessionTimeout: '60' } }]))
    expect(r.warnings.some((w) => w.code === 'singleton')).toBe(true)
  })
})

describe('buildOverlay', () => {
  it('includes only set fields with tri-state booleans resolved', () => {
    const spec = extractEnterpriseSettingsSpecs(ctxWith([{ fields: { sessionTimeout: '60', alarmEnabled: 'false', requireAlertDismissalNote: '' } }]).canvas)[0]
    const o = buildOverlay(spec)
    expect(o.sessionTimeout).toBe(60)
    expect(o.alarmEnabled).toBe(false)
    expect('requireAlertDismissalNote' in o).toBe(false)
  })
})

describe('parseDefaultPolicies', () => {
  it('parses a JSON object', () => {
    expect(parseDefaultPolicies('{"high":true}').value).toEqual({ high: true })
  })

  it('flags an array', () => {
    expect(parseDefaultPolicies('[1]').error).toBe('Default policies must be a JSON object of severity -> bool')
  })
})
