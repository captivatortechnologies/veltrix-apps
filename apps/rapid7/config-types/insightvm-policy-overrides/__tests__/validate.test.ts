import validate, {
  extractOverrideSpecs,
  overrideKey,
  overrideLabel,
  liveOverrideKey,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-policy-overrides',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-policy-overrides',
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

describe('InsightVM Policy Overrides Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a specific-asset override and warns about no expiration', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Override', fields: { rule_id: 42, scope_type: 'specific-asset', asset_id: 1001, new_result: 'Pass' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings.some((w) => w.code === 'no_expiration')).toBe(true)
  })

  it('is valid with no warning when an expiration is set', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Override',
          fields: {
            rule_id: 42,
            scope_type: 'all-assets',
            new_result: 'Pass',
            expires: '2026-12-31T00:00:00.000Z',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects a missing rule id and new result', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { scope_type: 'all-assets' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('rule_id'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('new_result'))).toBe(true)
  })

  it('rejects an unsupported scope type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { rule_id: 1, scope_type: 'everywhere', new_result: 'Pass' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_scope_type')).toBe(true)
  })

  it('requires an asset id for a specific-asset scope', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { rule_id: 1, scope_type: 'specific-asset', new_result: 'Pass' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('asset_id'))).toBe(true)
  })

  it('does not require an asset id for an all-assets scope', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { rule_id: 1, scope_type: 'all-assets', new_result: 'Pass' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate (rule, scope) override', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { rule_id: 1, scope_type: 'specific-asset', asset_id: 5, new_result: 'Pass' } },
        { name: 'b', fields: { rule_id: 1, scope_type: 'specific-asset', asset_id: 5, new_result: 'Fail' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_override')).toBe(true)
  })

  it('extract + helpers behave', () => {
    const specs = extractOverrideSpecs(
      makeCtx([
        { name: 's', fields: { rule_id: '7', scope_type: 'specific-asset', asset_id: '1001', new_result: '  Pass  ', original_result: 'Fail', expires: ' 2026-01-01 ' } },
      ]).canvas,
    )
    expect(specs[0].ruleId).toBe(7)
    expect(specs[0].assetId).toBe(1001)
    expect(specs[0].newResult).toBe('Pass')
    expect(specs[0].originalResult).toBe('Fail')
    expect(overrideLabel(specs[0])).toBe('rule 7 (specific-asset:1001)')
    expect(overrideKey({ ruleId: 7, scopeType: 'specific-asset', assetId: 1001 })).toBe(
      liveOverrideKey({ scope: { rule: 7, type: 'specific-asset', asset: 1001 } }) as string,
    )
    // An all-assets key ignores the asset component even if one is present.
    expect(overrideKey({ ruleId: 7, scopeType: 'all-assets', assetId: 1001 })).toBe(
      overrideKey({ ruleId: 7, scopeType: 'all-assets', assetId: undefined }),
    )
    // A live object without identity yields null.
    expect(liveOverrideKey({ id: 9 })).toBeNull()
  })
})
