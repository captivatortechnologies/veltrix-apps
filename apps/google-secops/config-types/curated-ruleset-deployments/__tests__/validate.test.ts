import validate, { extractCuratedDeploymentSpecs } from '../validate'
import { deploymentBody, deploymentMatches, deploymentPath } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('curated-ruleset-deployments validate', () => {
  it('accepts a valid deployment', () => {
    const r = validate(ctxWith([{ name: 'c1', fields: { category: 'cat-uuid', ruleSet: 'set-uuid', precision: 'broad', enabled: true, alerting: true } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires category and rule set ids', () => {
    const r = validate(ctxWith([{ name: '', fields: { precision: 'broad' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid precision', () => {
    const r = validate(ctxWith([{ name: 'c1', fields: { category: 'a', ruleSet: 'b', precision: 'medium' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_precision')).toBe(true)
  })

  it('rejects a duplicate category/ruleSet/precision', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { category: 'c', ruleSet: 's', precision: 'broad' } },
        { name: 'b', fields: { category: 'c', ruleSet: 's', precision: 'broad' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('warns when alerting without enabled', () => {
    const r = validate(ctxWith([{ name: 'c1', fields: { category: 'c', ruleSet: 's', precision: 'precise', alerting: true, enabled: false } }]))
    expect(r.warnings.some((w) => w.code === 'alerting_without_enabled')).toBe(true)
  })
})

describe('extractCuratedDeploymentSpecs / deploy helpers', () => {
  it('maps items to specs and defaults precision to broad', () => {
    const specs = extractCuratedDeploymentSpecs(ctxWith([{ id: 'i1', name: 'c', fields: { category: 'c', ruleSet: 's', enabled: true } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].precision).toBe('broad')
    expect(specs[0].enabled).toBe(true)
  })

  it('builds a body, matches live state and a deployment path', () => {
    const spec = { category: 'c', ruleSet: 's', precision: 'broad', enabled: true, alerting: false }
    const body = deploymentBody(spec) as { enabled: boolean; alerting: boolean }
    expect(body.enabled).toBe(true)
    expect(deploymentMatches({ enabled: true, alerting: false }, spec)).toBe(true)
    expect(deploymentMatches({ enabled: false }, spec)).toBe(false)
    expect(deploymentPath('P', spec)).toBe('P/curatedRuleSetCategories/c/curatedRuleSets/s/curatedRuleSetDeployments/broad')
  })
})
