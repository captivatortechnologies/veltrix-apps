import validate, {
  extractSentinelPolicySpecs,
  checkSentinelPolicy,
  normalizeSentinelPolicy,
  sentinelKey,
} from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const SAMPLE_POLICY = 'main = rule { true }'

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'sentinel-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'sentinel-policies',
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
    toolType: 'hashicorp-vault',
    entityType: 'sentinel-policies',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Vault Sentinel Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid RGP policy', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { scope: 'rgp', name: 'require-mfa', policy: SAMPLE_POLICY, enforcementLevel: 'advisory' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid EGP policy with paths', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p1',
          fields: { scope: 'egp', name: 'protect-secrets', policy: SAMPLE_POLICY, enforcementLevel: 'hard-mandatory', paths: ['secret/*'] },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing scope', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { name: 'x', policy: SAMPLE_POLICY, enforcementLevel: 'advisory' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('scope'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { scope: 'rgp', policy: SAMPLE_POLICY, enforcementLevel: 'advisory' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing policy body', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { scope: 'rgp', name: 'x', enforcementLevel: 'advisory' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('policy'))).toBe(true)
  })

  it('rejects a policy missing a main rule', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { scope: 'rgp', name: 'x', policy: 'x = 1', enforcementLevel: 'advisory' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_main')).toBe(true)
  })

  it('rejects unbalanced braces', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { scope: 'rgp', name: 'x', policy: 'main = rule { true', enforcementLevel: 'advisory' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'unbalanced_braces')).toBe(true)
  })

  it('rejects a missing enforcement level', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { scope: 'rgp', name: 'x', policy: SAMPLE_POLICY } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('enforcementLevel'))).toBe(true)
  })

  it('rejects an invalid enforcement level', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { scope: 'rgp', name: 'x', policy: SAMPLE_POLICY, enforcementLevel: 'strict' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_enforcement_level')).toBe(true)
  })

  it('rejects an EGP policy with no paths', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { scope: 'egp', name: 'x', policy: SAMPLE_POLICY, enforcementLevel: 'advisory' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('paths'))).toBe(true)
  })

  it('rejects an RGP policy that sets paths', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { scope: 'rgp', name: 'x', policy: SAMPLE_POLICY, enforcementLevel: 'advisory', paths: ['secret/*'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'paths_not_allowed')).toBe(true)
  })

  it('rejects a duplicate (scope, name)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'p1', fields: { scope: 'rgp', name: 'dup', policy: SAMPLE_POLICY, enforcementLevel: 'advisory' } },
        { name: 'p2', fields: { scope: 'rgp', name: 'dup', policy: SAMPLE_POLICY, enforcementLevel: 'advisory' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('allows the same name in both rgp and egp scopes', async () => {
    const result = await validate(
      makeCtx([
        { name: 'p1', fields: { scope: 'rgp', name: 'shared-name', policy: SAMPLE_POLICY, enforcementLevel: 'advisory' } },
        { name: 'p2', fields: { scope: 'egp', name: 'shared-name', policy: SAMPLE_POLICY, enforcementLevel: 'advisory', paths: ['*'] } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('checkSentinelPolicy', () => {
  it('accepts a well-formed policy', () => {
    expect(checkSentinelPolicy(SAMPLE_POLICY).ok).toBe(true)
  })
  it('flags an empty policy', () => {
    expect(checkSentinelPolicy('   ').reason).toBe('empty')
  })
  it('flags unbalanced braces', () => {
    expect(checkSentinelPolicy('main = rule { true').reason).toBe('unbalanced_braces')
  })
  it('flags a missing main rule', () => {
    expect(checkSentinelPolicy('x = 1').reason).toBe('missing_main')
  })
})

describe('normalizeSentinelPolicy', () => {
  it('strips line comments and collapses whitespace', () => {
    expect(normalizeSentinelPolicy('main = rule { true } # a comment\n\n  ')).toBe('main = rule { true }')
  })
})

describe('extractSentinelPolicySpecs', () => {
  it('lower-cases scope and name, trims policy, and parses paths', () => {
    const specs = extractSentinelPolicySpecs(
      makeCanvas([
        {
          name: 'p1',
          fields: { scope: '  EGP  ', name: '  Protect-Secrets  ', policy: `  ${SAMPLE_POLICY}  `, paths: 'secret/*, auth/*' },
        },
      ]),
    )
    expect(specs[0].scope).toBe('egp')
    expect(specs[0].name).toBe('protect-secrets')
    expect(specs[0].policy).toBe(SAMPLE_POLICY)
    expect(specs[0].paths).toEqual(['secret/*', 'auth/*'])
  })

  it('yields an empty scope for an unrecognized value', () => {
    const specs = extractSentinelPolicySpecs(makeCanvas([{ name: 'p1', fields: { scope: 'nonsense' } }]))
    expect(specs[0].scope).toBe('')
  })
})

describe('sentinelKey', () => {
  it('joins scope and name', () => {
    expect(sentinelKey('rgp', 'x')).toBe('rgp/x')
  })
})
