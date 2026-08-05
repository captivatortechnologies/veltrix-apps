import validate, {
  checkRiskPolicyElement,
  extractRiskPolicySetSpecs,
  parseRiskPoliciesArray,
  stripPolicyPriority,
  stripReadOnlyRiskPolicySet,
} from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'ping-identity',
    customerId: 'cust-1',
    configTypeId: 'risk-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'ping-identity',
      entityType: 'risk-policies',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'ping-identity',
    entityType: 'risk-policies',
    items: sections,
    sections,
    snapshot: {},
  }
}

const IP_RANGE_POLICIES =
  '[{"name":"Block known bad ASN","condition":{"type":"IP_RANGE","contains":"${event.ip}","ipRange":["203.0.113.0/24"]},"result":{"level":"HIGH","type":"VALUE"}}]'
const VALUE_COMPARISON_POLICIES =
  '[{"name":"Step up on anomalous device","condition":{"type":"VALUE_COMPARISON","equals":{"compactName":"deviceValue","value":"HIGH"}},"result":{"level":"MEDIUM","type":"VALUE"}}]'
const AGGREGATED_WEIGHTS_POLICIES =
  '[{"name":"Weighted composite risk","condition":{"type":"AGGREGATED_WEIGHTS","aggregatedWeights":[{"value":"HIGH","weight":80}]},"result":{"level":"MEDIUM","type":"VALUE"}}]'
const AGGREGATED_SCORES_POLICIES =
  '[{"name":"Scored composite risk","condition":{"type":"AGGREGATED_SCORES","aggregatedScores":[{"value":"HIGH","score":90}]},"result":{"level":"HIGH","type":"VALUE"}}]'

describe('PingOne Risk Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal risk policy set (name only)', async () => {
    const result = await validate(makeCtx([{ name: 'Set', fields: { name: 'Default Risk Policy' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a set with description, default flag and predictors', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Set',
          fields: {
            name: 'Prod Risk Policy',
            description: 'Production risk policy set',
            default: true,
            evaluatedPredictorIds: ['predictor-1', 'predictor-2'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a set with IP_RANGE policies', async () => {
    const result = await validate(
      makeCtx([{ name: 'Set', fields: { name: 'IP Set', riskPoliciesJson: IP_RANGE_POLICIES } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a set with VALUE_COMPARISON policies', async () => {
    const result = await validate(
      makeCtx([{ name: 'Set', fields: { name: 'Value Set', riskPoliciesJson: VALUE_COMPARISON_POLICIES } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a set with AGGREGATED_WEIGHTS policies', async () => {
    const result = await validate(
      makeCtx([{ name: 'Set', fields: { name: 'Weighted Set', riskPoliciesJson: AGGREGATED_WEIGHTS_POLICIES } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a set with AGGREGATED_SCORES policies', async () => {
    const result = await validate(
      makeCtx([{ name: 'Set', fields: { name: 'Scored Set', riskPoliciesJson: AGGREGATED_SCORES_POLICIES } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 256 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(257) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a duplicate set name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Default' } },
        { name: 'sec2', fields: { name: 'default' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects riskPoliciesJson that is not a JSON array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Set', riskPoliciesJson: '{"name":"x"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policies')).toBe(true)
  })

  it('rejects malformed riskPoliciesJson', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Set', riskPoliciesJson: '[not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policies')).toBe(true)
  })

  it('rejects a policy element that is not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Set', riskPoliciesJson: '["oops"]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy_element')).toBe(true)
  })

  it('rejects a policy with no condition', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Set', riskPoliciesJson: '[{"result":{"level":"LOW"}}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy_element')).toBe(true)
  })

  it('rejects a policy with an invalid condition.type', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'Set',
            riskPoliciesJson: '[{"condition":{"type":"MAGIC"},"result":{"level":"LOW"}}]',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy_element')).toBe(true)
  })

  it('rejects an IP_RANGE condition with no ipRange', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'Set',
            riskPoliciesJson: '[{"condition":{"type":"IP_RANGE"},"result":{"level":"HIGH"}}]',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy_element')).toBe(true)
  })

  it('rejects a VALUE_COMPARISON condition with no equals', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'Set',
            riskPoliciesJson: '[{"condition":{"type":"VALUE_COMPARISON"},"result":{"level":"MEDIUM"}}]',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy_element')).toBe(true)
  })

  it('rejects a policy with no result', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'Set',
            riskPoliciesJson: '[{"condition":{"type":"IP_RANGE","ipRange":["1.2.3.0/24"]}}]',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy_element')).toBe(true)
  })

  it('rejects a result.level outside LOW/MEDIUM/HIGH', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'Set',
            riskPoliciesJson:
              '[{"condition":{"type":"IP_RANGE","ipRange":["1.2.3.0/24"]},"result":{"level":"CRITICAL"}}]',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy_element')).toBe(true)
  })
})

describe('extractRiskPolicySetSpecs', () => {
  it('trims fields, drops empty optionals and parses the predictor list', () => {
    const specs = extractRiskPolicySetSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: '  Prod Set  ',
            description: '  ',
            default: true,
            evaluatedPredictorIds: 'predictor-1, predictor-2',
            riskPoliciesJson: '',
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('Prod Set')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].default).toBe(true)
    expect(specs[0].evaluatedPredictorIds).toEqual(['predictor-1', 'predictor-2'])
    expect(specs[0].riskPoliciesJson).toBeUndefined()
  })

  it('reads predictor ids from an array field and defaults default to false', () => {
    const specs = extractRiskPolicySetSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'x', evaluatedPredictorIds: ['p1', 'p2'] } }]),
    )
    expect(specs[0].evaluatedPredictorIds).toEqual(['p1', 'p2'])
    expect(specs[0].default).toBe(false)
  })
})

describe('parseRiskPoliciesArray', () => {
  it('parses a JSON array', () => {
    expect(parseRiskPoliciesArray('[{"name":"r1"}]')).toEqual([{ name: 'r1' }])
  })
  it('rejects a JSON object', () => {
    expect(parseRiskPoliciesArray('{"name":"r1"}')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseRiskPoliciesArray('[nope')).toBe(null)
  })
})

describe('checkRiskPolicyElement', () => {
  it('accepts a valid IP_RANGE policy', () => {
    expect(
      checkRiskPolicyElement(
        { condition: { type: 'IP_RANGE', ipRange: ['1.2.3.0/24'] }, result: { level: 'HIGH' } },
        0,
      ),
    ).toBeNull()
  })
  it('accepts a valid VALUE_COMPARISON policy', () => {
    expect(
      checkRiskPolicyElement(
        { condition: { type: 'VALUE_COMPARISON', equals: { compactName: 'x', value: 'y' } }, result: { level: 'LOW' } },
        0,
      ),
    ).toBeNull()
  })
  it('rejects a non-object policy', () => {
    expect(checkRiskPolicyElement('nope', 0)).toMatch(/must be a JSON object/)
  })
  it('rejects a missing condition', () => {
    expect(checkRiskPolicyElement({ result: {} }, 0)).toMatch(/condition/)
  })
})

describe('stripPolicyPriority', () => {
  it('removes priority from each riskPolicies entry', () => {
    expect(
      stripPolicyPriority([
        { name: 'r1', priority: 1, condition: {}, result: {} },
        { name: 'r2', priority: 2, condition: {}, result: {} },
      ]),
    ).toEqual([
      { name: 'r1', condition: {}, result: {} },
      { name: 'r2', condition: {}, result: {} },
    ])
  })
  it('returns an empty array for a non-array input', () => {
    expect(stripPolicyPriority(undefined)).toEqual([])
  })
})

describe('stripReadOnlyRiskPolicySet', () => {
  it('drops server-managed read-only fields and strips nested priority', () => {
    const stripped = stripReadOnlyRiskPolicySet({
      id: 'rps1',
      name: 'Default',
      default: true,
      environment: { id: 'env1' },
      createdAt: 'x',
      updatedAt: 'y',
      triggers: {},
      _links: {},
      riskPolicies: [{ name: 'r1', priority: 1, condition: {}, result: {} }],
    })
    expect(stripped).toEqual({
      name: 'Default',
      default: true,
      riskPolicies: [{ name: 'r1', condition: {}, result: {} }],
    })
  })
})
