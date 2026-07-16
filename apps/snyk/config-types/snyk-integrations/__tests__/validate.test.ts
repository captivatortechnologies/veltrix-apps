import validate, {
  checkLimit,
  extractIntegrationSpecs,
  integrationKey,
  readBool,
  readNumber,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-integrations',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-integrations',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { org_id: 'org-123' },
    platform: stubPlatform,
  }
}

describe('Snyk Integration Settings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid integration item', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'GH',
          fields: {
            integration_type: 'github',
            pull_request_test_enabled: true,
            pull_request_fail_on_any_vulns: false,
            pull_request_fail_only_high: true,
            auto_dep_upgrade_enabled: true,
            auto_dep_upgrade_limit: 5,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires an integration type', async () => {
    const result = await validate(makeCtx([{ name: 'GH', fields: { pull_request_test_enabled: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('integration_type'))).toBe(true)
  })

  it('rejects an unsupported integration type', async () => {
    const result = await validate(makeCtx([{ name: 'X', fields: { integration_type: 'perforce' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects a non-positive-integer upgrade limit', async () => {
    for (const bad of [0, -3, 2.5, 'abc']) {
      const result = await validate(makeCtx([{ name: 'GH', fields: { integration_type: 'github', auto_dep_upgrade_limit: bad } }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'invalid_limit')).toBe(true)
    }
  })

  it('accepts a blank upgrade limit (optional field)', async () => {
    const result = await validate(makeCtx([{ name: 'GH', fields: { integration_type: 'github', auto_dep_upgrade_limit: '' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects duplicate integration types case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { integration_type: 'github' } },
        { name: 'b', fields: { integration_type: 'GitHub' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_integration')).toBe(true)
  })

  it('helpers behave', () => {
    expect(integrationKey('  GitHub ')).toBe('github')
    expect(readBool(true, false)).toBe(true)
    expect(readBool('yes', false)).toBe(true)
    expect(readBool(undefined, true)).toBe(true)
    expect(readNumber('5')).toBe(5)
    expect(readNumber('  ')).toBeUndefined()
    expect(readNumber('abc')).toBeUndefined()
    expect(checkLimit('')).toBeNull()
    expect(checkLimit(undefined)).toBeNull()
    expect(checkLimit(3)).toBeNull()
    expect(checkLimit(0)).toContain('positive integer')
    expect(checkLimit(-1)).toContain('positive integer')
    expect(checkLimit(1.5)).toContain('positive integer')

    const specs = extractIntegrationSpecs(
      makeCtx([{ name: 'gh', fields: { integration_type: '  github  ', auto_dep_upgrade_limit: '7' } }]).canvas,
    )
    expect(specs[0].integrationType).toBe('github')
    expect(specs[0].autoDepUpgradeLimit).toBe(7)
    expect(specs[0].prTestEnabled).toBe(false)
  })
})
