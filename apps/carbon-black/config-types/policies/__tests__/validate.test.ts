import validate, { extractPolicySpecs, parsePolicyBody } from '../validate'
import { policyBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const BODY = '{"av_settings":{"onAccessScan":{"enabled":true}},"rules":[]}'

describe('policies validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(ctxWith([{ name: 'Standard', fields: { name: 'Standard', priorityLevel: 'HIGH', policyJson: BODY } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name and policy json', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.filter((e) => e.code === 'required').length >= 2).toBe(true)
  })

  it('rejects an invalid priority level', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', priorityLevel: 'URGENT', policyJson: BODY } }]))
    expect(r.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('rejects malformed policy json', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', priorityLevel: 'LOW', policyJson: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects policy json whose rules is not an array', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', priorityLevel: 'LOW', policyJson: '{"rules":"nope"}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_rules')).toBe(true)
  })

  it('flags a duplicate policy name', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', priorityLevel: 'LOW', policyJson: BODY } },
        { name: 'dup', fields: { name: 'dup', priorityLevel: 'LOW', policyJson: BODY } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('warns on a policy body with no protections', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', priorityLevel: 'LOW', policyJson: '{"org_key":"x"}' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_policy')).toBe(true)
  })
})

describe('policyBody / parsePolicyBody', () => {
  it('merges managed fields on top of the parsed body', () => {
    const spec = extractPolicySpecs(
      ctxWith([{ name: 'P', fields: { name: 'P', description: 'd', priorityLevel: 'MISSION_CRITICAL', policyJson: BODY } }]).canvas
    )[0]
    const body = policyBody(spec, 'ORG1') as { name: string; description: string; priority_level: string; org_key: string; is_system: boolean; rules: unknown[] }
    expect(body.name).toBe('P')
    expect(body.description).toBe('d')
    expect(body.priority_level).toBe('MISSION_CRITICAL')
    expect(body.org_key).toBe('ORG1')
    expect(body.is_system).toBe(false)
    expect(body.rules).toEqual([])
  })

  it('parses only JSON objects', () => {
    expect(parsePolicyBody('[]')).toBe(null)
    expect(parsePolicyBody('"x"')).toBe(null)
  })
})
