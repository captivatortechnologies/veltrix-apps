import validate, { extractSessionPolicySpecs, liveConnectorMap } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-platform-session-policy',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-platform-session-policy',
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

const validFields = { platform_id: 'WinServerLocal', psm_server_id: 'PSMServer_abc123' }

describe('CyberArk Platform Session Policy Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal policy', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires platform_id and psm_server_id', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('platform_id'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('psm_server_id'))).toBe(true)
  })

  it('rejects duplicate platform ids case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields } },
        { name: 'b', fields: { ...validFields, platform_id: validFields.platform_id.toUpperCase() } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_platform')).toBe(true)
  })

  it('extracts a keyvalue connectors map', () => {
    const specs = extractSessionPolicySpecs(
      makeCtx([{ name: 'a', fields: { ...validFields, psm_connectors: { SSH: 'true', 'PSM-RDP': 'false' } } }]).canvas,
    )
    expect(specs[0].psmConnectors).toEqual({ SSH: true, 'PSM-RDP': false })
  })

  it('liveConnectorMap ignores entries with no PSMConnectorID', () => {
    const map = liveConnectorMap([{ PSMConnectorID: 'SSH', Enabled: true }, { Enabled: false }])
    expect(map).toEqual({ SSH: true })
  })
})
