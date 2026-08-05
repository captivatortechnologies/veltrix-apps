import validate, {
  extractAuthenticationRuleSpecs,
  buildAuthenticationRuleFields,
  authenticationRuleDriftDiffs,
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
    configTypeId: 'panorama-authentication-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-authentication-rules',
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

describe('Panorama Authentication Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal rule with an enforcement object', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'guest-wifi-auth', authentication_enforcement: 'guest-captive-portal' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('requires an authentication enforcement object', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', authentication_enforcement: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.authentication_enforcement'))).toBe(true)
  })

  it('rejects a non-positive timeout', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'x', authentication_enforcement: 'p', timeout: 0 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_timeout')).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'auth1', authentication_enforcement: 'p' } },
        { name: 'b', fields: { name: 'AUTH1', authentication_enforcement: 'p' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('defaults match fields and builds the enforcement + timeout fields', () => {
    const spec = extractAuthenticationRuleSpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', authentication_enforcement: 'corp-auth-profile' } }]).canvas,
    )[0]
    const fields = buildAuthenticationRuleFields(spec)
    expect(fields.from).toEqual({ member: ['any'] })
    expect(fields['source-user']).toEqual({ member: ['any'] })
    expect(fields['authentication-enforcement']).toBe('corp-auth-profile')
    expect(fields.timeout).toBe(60)
    expect(fields['log-authentication-timeout']).toBe('yes')
  })

  it('detects enforcement and timeout drift', () => {
    const spec = extractAuthenticationRuleSpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', authentication_enforcement: 'corp-auth-profile' } }]).canvas,
    )[0]
    const clean = authenticationRuleDriftDiffs(spec, {
      '@name': 'x',
      from: { member: ['any'] },
      to: { member: ['any'] },
      source: { member: ['any'] },
      destination: { member: ['any'] },
      'source-user': { member: ['any'] },
      service: { member: ['any'] },
      category: { member: ['any'] },
      'authentication-enforcement': 'corp-auth-profile',
      timeout: 60,
      'log-authentication-timeout': 'yes',
      disabled: 'no',
    })
    expect(clean).toHaveLength(0)
    const drifted = authenticationRuleDriftDiffs(spec, { '@name': 'x', 'authentication-enforcement': 'other-profile', timeout: 30 })
    expect(drifted.some((d) => d.field.endsWith('.authentication-enforcement'))).toBe(true)
    expect(drifted.some((d) => d.field.endsWith('.timeout'))).toBe(true)
  })
})
