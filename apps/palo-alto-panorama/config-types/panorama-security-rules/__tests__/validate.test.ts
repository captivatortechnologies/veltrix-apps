import validate, {
  extractSecurityRuleSpecs,
  buildSecurityRuleFields,
  securityRuleDriftDiffs,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-security-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-security-rules',
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

describe('Panorama Security Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal allow rule', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'allow-web', action: 'allow' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an unsupported action', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', action: 'reject' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('rejects duplicate rule names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'rule1', action: 'allow' } },
        { name: 'b', fields: { name: 'RULE1', action: 'deny' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('defaults match fields and builds member wrappers', () => {
    const spec = extractSecurityRuleSpecs(makeCtx([{ name: 'r', fields: { name: 'allow-web', action: 'allow', application: ['ssl', 'web-browsing'] } }]).canvas)[0]
    const fields = buildSecurityRuleFields(spec) as Record<string, { member: string[] }> & Record<string, unknown>
    expect(fields.from).toEqual({ member: ['any'] })
    expect(fields.service).toEqual({ member: ['application-default'] })
    expect(fields.application).toEqual({ member: ['ssl', 'web-browsing'] })
    expect(fields.action).toBe('allow')
    expect(fields.disabled).toBe('no')
  })

  it('attaches a profile group and log setting when set', () => {
    const spec = extractSecurityRuleSpecs(
      makeCtx([{ name: 'r', fields: { name: 'r1', action: 'allow', profile_group: 'strict', log_setting: 'default', disabled: true } }]).canvas,
    )[0]
    const fields = buildSecurityRuleFields(spec)
    expect(fields['profile-setting']).toEqual({ group: { member: ['strict'] } })
    expect(fields['log-setting']).toBe('default')
    expect(fields.disabled).toBe('yes')
  })

  it('detects action and disabled drift', () => {
    const spec = extractSecurityRuleSpecs(makeCtx([{ name: 'r', fields: { name: 'allow-web', action: 'allow' } }]).canvas)[0]
    const clean = securityRuleDriftDiffs(spec, {
      '@name': 'allow-web',
      action: 'allow',
      from: { member: ['any'] },
      to: { member: ['any'] },
      source: { member: ['any'] },
      destination: { member: ['any'] },
      application: { member: ['any'] },
      service: { member: ['application-default'] },
      disabled: 'no',
    })
    expect(clean).toHaveLength(0)
    const drifted = securityRuleDriftDiffs(spec, { '@name': 'allow-web', action: 'deny' })
    expect(drifted.some((d) => d.field.endsWith('.action'))).toBe(true)
  })
})
