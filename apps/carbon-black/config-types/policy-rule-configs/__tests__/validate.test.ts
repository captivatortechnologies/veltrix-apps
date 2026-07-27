import validate, { extractRuleConfigSpecs, parseExclusions } from '../validate'
import { buildBody, snapshotConfigs } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('policy-rule-configs validate', () => {
  it('accepts a valid BLOCK config', () => {
    const r = validate(ctxWith([{ name: 'C', fields: { policyName: 'Standard', assignmentMode: 'BLOCK' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a policy name', () => {
    const r = validate(ctxWith([{ name: '', fields: { assignmentMode: 'BLOCK' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid assignment mode', () => {
    const r = validate(ctxWith([{ name: 'C', fields: { policyName: 'P', assignmentMode: 'MONITOR' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_mode')).toBe(true)
  })

  it('rejects malformed exclusions json', () => {
    const r = validate(ctxWith([{ name: 'C', fields: { policyName: 'P', assignmentMode: 'BLOCK', exclusionsJson: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('flags two configs for the same policy', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { policyName: 'Standard', assignmentMode: 'BLOCK' } },
        { name: 'B', fields: { policyName: 'standard', assignmentMode: 'REPORT' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })
})

describe('buildBody / snapshotConfigs / parseExclusions', () => {
  it('builds a per-config PUT array applying the assignment mode', () => {
    const spec = extractRuleConfigSpecs(
      ctxWith([{ name: 'C', fields: { policyName: 'P', assignmentMode: 'REPORT' } }]).canvas
    )[0]
    const live = [{ id: 'uuid-1', category: 'core_prevention', parameters: { WindowsAssignmentMode: 'BLOCK' }, exclusions: { windows: [] } }]
    const body = buildBody(spec, live) as Array<{ id: string; parameters: { WindowsAssignmentMode: string }; exclusions?: unknown }>
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe('uuid-1')
    expect(body[0].parameters.WindowsAssignmentMode).toBe('REPORT')
    expect(body[0].exclusions).toEqual({ windows: [] })
    const snap = snapshotConfigs(live)
    expect(snap[0].id).toBe('uuid-1')
    expect(snap[0].WindowsAssignmentMode).toBe('BLOCK')
  })

  it('parses only JSON objects for exclusions', () => {
    expect(parseExclusions('[]')).toBe(null)
    expect(parseExclusions('{"windows":[]}')).toEqual({ windows: [] })
  })
})
