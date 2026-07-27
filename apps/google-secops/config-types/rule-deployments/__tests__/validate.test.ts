import validate, { extractRuleDeploymentSpecs } from '../validate'
import { deploymentBody, deploymentMatches } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('rule-deployments validate', () => {
  it('accepts a valid deployment', () => {
    const r = validate(ctxWith([{ name: 'r1', fields: { ruleName: 'suspicious_login', enabled: true, alerting: true, runFrequency: 'LIVE' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a rule name', () => {
    const r = validate(ctxWith([{ name: '', fields: { runFrequency: 'LIVE' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid run frequency', () => {
    const r = validate(ctxWith([{ name: 'r1', fields: { ruleName: 'r', runFrequency: 'WEEKLY' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_run_frequency')).toBe(true)
  })

  it('warns when alerting without enabled', () => {
    const r = validate(ctxWith([{ name: 'r1', fields: { ruleName: 'r', alerting: true, enabled: false, runFrequency: 'LIVE' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'alerting_without_enabled')).toBe(true)
  })

  it('rejects duplicate rule deployments', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { ruleName: 'dup', runFrequency: 'LIVE' } },
        { name: 'b', fields: { ruleName: 'dup', runFrequency: 'HOURLY' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })
})

describe('extractRuleDeploymentSpecs / deploymentBody / deploymentMatches', () => {
  it('maps items to specs and defaults run frequency to LIVE', () => {
    const specs = extractRuleDeploymentSpecs(ctxWith([{ id: 'i1', name: 'r', fields: { ruleName: 'r', enabled: true } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].runFrequency).toBe('LIVE')
    expect(specs[0].enabled).toBe(true)
  })

  it('builds a deployment body', () => {
    const body = deploymentBody({ ruleName: 'r', enabled: true, alerting: false, runFrequency: 'HOURLY' }) as { enabled: boolean; alerting: boolean; runFrequency: string }
    expect(body.enabled).toBe(true)
    expect(body.runFrequency).toBe('HOURLY')
  })

  it('matches live state, treating unspecified frequency as LIVE', () => {
    const spec = { ruleName: 'r', enabled: false, alerting: false, runFrequency: 'LIVE' }
    expect(deploymentMatches({}, spec)).toBe(true)
    expect(deploymentMatches({ enabled: true }, spec)).toBe(false)
  })
})
