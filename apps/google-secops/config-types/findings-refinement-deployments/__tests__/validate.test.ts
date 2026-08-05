import validate, { extractFindingsRefinementDeploymentSpecs, parseApplication } from '../validate'
import { buildDeploymentBody, deploymentMatches } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('findings-refinement-deployments validate', () => {
  it('accepts a valid deployment', () => {
    const r = validate(ctxWith([{ name: 'fr1', fields: { refinementName: 'Exclude test host', enabled: true, archived: false } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a refinement name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects archived together with enabled', () => {
    const r = validate(ctxWith([{ name: 'fr1', fields: { refinementName: 'r', enabled: true, archived: true } }]))
    expect(r.errors.some((e) => e.code === 'archived_with_enabled')).toBe(true)
  })

  it('rejects malformed detection exclusion application JSON', () => {
    const r = validate(ctxWith([{ name: 'fr1', fields: { refinementName: 'r', detectionExclusionApplication: '[not an object]' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate refinement deployments', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { refinementName: 'dup' } },
        { name: 'b', fields: { refinementName: 'dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_refinement')).toBe(true)
  })
})

describe('extractFindingsRefinementDeploymentSpecs / parseApplication', () => {
  it('maps items to specs and defaults an empty application scope', () => {
    const specs = extractFindingsRefinementDeploymentSpecs(ctxWith([{ id: 'i1', name: 'r', fields: { refinementName: 'r', enabled: true } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].application).toEqual({ ruleNames: [], curatedRuleSets: [], curatedRules: [] })
  })

  it('parses ruleNames / curatedRuleSets / curatedRules out of the application JSON', () => {
    const raw = JSON.stringify({ ruleNames: ['My Rule'], curatedRuleSets: ['projects/p/.../curatedRuleSets/s'], curatedRules: [] })
    expect(parseApplication(raw)).toEqual({ ruleNames: ['My Rule'], curatedRuleSets: ['projects/p/.../curatedRuleSets/s'], curatedRules: [] })
  })

  it('treats malformed JSON as null', () => {
    expect(parseApplication('{not json')).toBeNull()
  })

  it('treats an empty blob as an empty scope', () => {
    expect(parseApplication('')).toEqual({ ruleNames: [], curatedRuleSets: [], curatedRules: [] })
  })
})

describe('buildDeploymentBody / deploymentMatches', () => {
  it('builds a deployment body with the application scope', () => {
    const spec = { itemId: 'i1', refinementName: 'r', enabled: true, archived: false, applicationRaw: '', application: { ruleNames: [], curatedRuleSets: [], curatedRules: [] } }
    const body = buildDeploymentBody(spec, { rules: ['p/rules/1'], curatedRuleSets: [], curatedRules: [] }) as {
      enabled: boolean
      archived: boolean
      detectionExclusionApplication: { rules: string[] }
    }
    expect(body.enabled).toBe(true)
    expect(body.detectionExclusionApplication.rules).toEqual(['p/rules/1'])
  })

  it('matches live state including the application scope', () => {
    const spec = { itemId: 'i1', refinementName: 'r', enabled: true, archived: false, applicationRaw: '', application: { ruleNames: [], curatedRuleSets: [], curatedRules: [] } }
    expect(deploymentMatches({ enabled: true, archived: false }, spec, undefined)).toBe(true)
    expect(deploymentMatches({ enabled: false, archived: false }, spec, undefined)).toBe(false)
    expect(
      deploymentMatches(
        { enabled: true, archived: false, detectionExclusionApplication: { rules: ['a', 'b'] } },
        spec,
        { rules: ['b', 'a'] }
      )
    ).toBe(true)
  })
})
