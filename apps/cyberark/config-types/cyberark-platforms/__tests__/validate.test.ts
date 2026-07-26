import validate, { extractPlatformSpecs, platformKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-platforms',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-platforms',
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

describe('CyberArk Platforms Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a platform managed by active state alone (no package)', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { platform_id: 'WinServerLocal', active: true } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a platform with a valid BASE 64 import package', async () => {
    const result = await validate(
      makeCtx([{ name: 'P', fields: { platform_id: 'CustomUnix', import_package: 'UEsDBBQAAAA=' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('requires a platform id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { active: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('platform_id'))).toBe(true)
  })

  it('rejects a platform id longer than 99 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { platform_id: 'A'.repeat(100) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'platform_id_too_long')).toBe(true)
  })

  it('rejects a malformed BASE 64 import package', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { platform_id: 'X', import_package: 'not base64!!' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_package')).toBe(true)
  })

  it('rejects duplicate platform ids case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { platform_id: 'UnixSSH' } },
        { name: 'b', fields: { platform_id: 'unixssh' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_platform')).toBe(true)
  })

  it('extracts specs with defaults + helpers', () => {
    const specs = extractPlatformSpecs(
      makeCtx([{ name: 'p', fields: { platform_id: '  WinServerLocal  ', active: 'false', import_package: '  UEsDBBQ=  ' } }]).canvas,
    )
    expect(specs[0].platformId).toBe('WinServerLocal')
    expect(specs[0].active).toBe(false)
    expect(specs[0].importPackage).toBe('UEsDBBQ=')
    expect(platformKey(specs[0])).toBe(platformKey({ platformId: 'winserverlocal' }))
  })

  it('defaults active to true when unset', () => {
    const specs = extractPlatformSpecs(makeCtx([{ name: 'p', fields: { platform_id: 'X' } }]).canvas)
    expect(specs[0].active).toBe(true)
  })
})
