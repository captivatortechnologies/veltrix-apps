import validate, { extractSastSettings, readBool } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-sast-settings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-sast-settings',
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

describe('Snyk SAST Settings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates an enabled SAST settings item', async () => {
    const result = await validate(makeCtx([{ name: 'SAST', fields: { sast_enabled: true } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('warns when SAST is being disabled', async () => {
    const result = await validate(makeCtx([{ name: 'SAST', fields: { sast_enabled: false } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'sast_disabled')).toBe(true)
  })

  it('rejects more than one item (singleton)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { sast_enabled: true } },
        { name: 'b', fields: { sast_enabled: false } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'singleton_only')).toBe(true)
  })

  it('readBool + extract behave', () => {
    expect(readBool(true, false)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(readBool('yes', false)).toBe(true)
    expect(readBool(undefined, true)).toBe(true)
    expect(extractSastSettings(makeCtx([{ name: 's', fields: { sast_enabled: 'true' } }]).canvas).sastEnabled).toBe(true)
  })
})
