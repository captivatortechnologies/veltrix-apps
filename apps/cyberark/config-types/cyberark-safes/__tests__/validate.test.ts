import validate, { extractSafeSpecs, safeKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-safes',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-safes',
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

describe('CyberArk Safes Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid safe', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Safe', fields: { safe_name: 'App-Prod', description: 'prod creds', retention_type: 'days', retention_count: 7 } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a safe name and a retention count', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { description: 'no name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('safe_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('retention_count'))).toBe(true)
  })

  it('rejects a non-positive / non-integer retention count', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { safe_name: 'X', retention_count: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_retention')).toBe(true)
  })

  it('rejects a safe name longer than 28 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { safe_name: 'A'.repeat(29), retention_count: 5 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'safe_name_too_long')).toBe(true)
  })

  it('rejects duplicate safe names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { safe_name: 'Vault-A', retention_count: 5 } },
        { name: 'b', fields: { safe_name: 'vault-a', retention_count: 5 } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_safe')).toBe(true)
  })

  it('extracts specs with defaults + helpers', () => {
    const specs = extractSafeSpecs(
      makeCtx([
        {
          name: 's',
          fields: {
            safe_name: '  App-Prod  ',
            retention_count: '10',
            olac_enabled: true,
            auto_purge_enabled: 'true',
          },
        },
      ]).canvas,
    )
    expect(specs[0].safeName).toBe('App-Prod')
    expect(specs[0].retentionType).toBe('versions')
    expect(specs[0].retentionCount).toBe(10)
    expect(specs[0].olacEnabled).toBe(true)
    expect(specs[0].autoPurgeEnabled).toBe(true)
    expect(safeKey(specs[0])).toBe(safeKey({ safeName: 'app-prod' }))
  })
})
