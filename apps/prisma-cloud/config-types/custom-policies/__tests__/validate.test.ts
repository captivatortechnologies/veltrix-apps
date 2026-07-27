import validate, { splitList, extractPolicySpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('custom-policies validate', () => {
  it('accepts a valid config policy with saved-search criteria', () => {
    const r = validate(ctxWith([{ name: 'Public S3', fields: { name: 'Public S3', policyType: 'config', ruleType: 'Config', criteria: 'ss-123', severity: 'high' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { policyType: 'config', ruleType: 'Anomaly' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires criteria for a Config rule type', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', policyType: 'config', ruleType: 'Config' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.criteria'))).toBe(true)
  })

  it('does not require criteria for an Anomaly rule type', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', policyType: 'anomaly', ruleType: 'Anomaly' } }]))
    expect(r.valid).toBe(true)
  })

  it('rejects an invalid policy type', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', policyType: 'nonsense', ruleType: 'Anomaly' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_policy_type')).toBe(true)
  })

  it('rejects an invalid severity', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', policyType: 'anomaly', ruleType: 'Anomaly', severity: 'urgent' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', policyType: 'anomaly', ruleType: 'Anomaly' } },
        { name: 'Dup', fields: { name: 'Dup', policyType: 'anomaly', ruleType: 'Anomaly' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitList', () => {
  it('splits, trims and de-duplicates', () => {
    expect(splitList('a\nb, a')).toEqual(['a', 'b'])
    expect(splitList('')).toEqual([])
  })
})

describe('extractPolicySpecs', () => {
  it('defaults enabled to true and parses labels', () => {
    const specs = extractPolicySpecs({
      items: [{ id: 'i1', name: 'P', fields: { name: 'P', policyType: 'config', ruleType: 'Config', criteria: 'ss-1', labels: 'a\nb' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].labels).toEqual(['a', 'b'])
  })
})
