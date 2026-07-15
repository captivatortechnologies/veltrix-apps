import validate, {
  extractIlmPolicySpecs,
  isProtectedPolicyName,
  parsePolicyObject,
} from '../validate'
import { isDeepSubset } from '../driftDetect'
import { isManagedPolicy } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'ilm-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'ilm-policies',
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

const VALID_POLICY =
  '{"phases":{"hot":{"min_age":"0ms","actions":{"rollover":{"max_age":"30d"}}},"delete":{"min_age":"90d","actions":{"delete":{}}}}}'

describe('Elastic ILM Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid policy', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { name: 'logs-30-days', policyJson: VALID_POLICY } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { policyJson: VALID_POLICY } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name starting with a dot (managed convention)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: '.managed-policy', policyJson: VALID_POLICY } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_policy')).toBe(true)
  })

  it('rejects a name starting with an at-sign (managed convention)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: '@lifecycle', policyJson: VALID_POLICY } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_policy')).toBe(true)
  })

  it('rejects a missing policyJson', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'logs-30-days' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('policyJson'))).toBe(true)
  })

  it('rejects malformed policy JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'logs-30-days', policyJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy')).toBe(true)
  })

  it('rejects a policy that is a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'logs-30-days', policyJson: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy')).toBe(true)
  })

  it('warns (but does not fail) when a policy has no phases object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'logs-30-days', policyJson: '{"_meta":{"note":"x"}}' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_phases')).toBe(true)
  })

  it('rejects a duplicate policy name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'logs-30-days', policyJson: VALID_POLICY } },
        { name: 'sec2', fields: { name: 'logs-30-days', policyJson: VALID_POLICY } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('allows two distinct policy names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'logs-30-days', policyJson: VALID_POLICY } },
        { name: 'sec2', fields: { name: 'metrics-7-days', policyJson: VALID_POLICY } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractIlmPolicySpecs', () => {
  it('trims fields and drops a blank policyJson', () => {
    const specs = extractIlmPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'ilm-policies',
      items: [],
      sections: [
        { name: 'sec1', fields: { name: '  logs-30-days  ', policyJson: '   ' } },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('logs-30-days')
    expect(specs[0].policyJson).toBeUndefined()
  })
})

describe('parsePolicyObject', () => {
  it('parses a JSON object', () => {
    expect(parsePolicyObject('{"phases":{}}')).toEqual({ phases: {} })
  })
  it('rejects a JSON array', () => {
    expect(parsePolicyObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parsePolicyObject('{nope')).toBe(null)
  })
})

describe('isProtectedPolicyName', () => {
  it('flags names starting with a dot', () => {
    expect(isProtectedPolicyName('.managed')).toBe(true)
  })
  it('flags names starting with an at-sign', () => {
    expect(isProtectedPolicyName('@lifecycle')).toBe(true)
  })
  it('allows an ordinary name', () => {
    expect(isProtectedPolicyName('logs-30-days')).toBe(false)
  })
})

describe('isManagedPolicy', () => {
  it('flags a policy with _meta.managed true', () => {
    expect(isManagedPolicy({ policy: { phases: {}, _meta: { managed: true } } })).toBe(true)
  })
  it('does not flag a policy without the managed flag', () => {
    expect(isManagedPolicy({ policy: { phases: {}, _meta: { managed: false } } })).toBe(false)
    expect(isManagedPolicy({ policy: { phases: {} } })).toBe(false)
    expect(isManagedPolicy({})).toBe(false)
  })
})

describe('isDeepSubset (drift comparison)', () => {
  it('treats server-injected extra keys as NOT drift', () => {
    const authored = { phases: { hot: { actions: { rollover: { max_age: '30d' } } } } }
    const live = {
      phases: { hot: { min_age: '0ms', actions: { rollover: { max_age: '30d', max_docs: 100 } } } },
    }
    expect(isDeepSubset(authored, live)).toBe(true)
  })
  it('detects a changed authored value', () => {
    const authored = { phases: { delete: { min_age: '90d' } } }
    const live = { phases: { delete: { min_age: '30d' } } }
    expect(isDeepSubset(authored, live)).toBe(false)
  })
  it('detects a missing authored key', () => {
    expect(isDeepSubset({ phases: { warm: {} } }, { phases: { hot: {} } })).toBe(false)
  })
})
