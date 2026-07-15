import validate, { extractZoneSettingSpecs, normalizeSettingValue, settingKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-zone-settings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-zone-settings',
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

describe('Cloudflare Zone Settings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid setting', async () => {
    const result = await validate(makeCtx([{ name: 'Zone Setting', fields: { setting_id: 'ssl', value: 'full' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing setting_id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { value: 'medium' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('setting_id'))).toBe(true)
  })

  it('rejects a missing value', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { setting_id: 'security_level' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('value'))).toBe(true)
  })

  it('rejects a duplicate setting_id (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { setting_id: 'ssl', value: 'full' } },
        { name: 'b', fields: { setting_id: 'SSL', value: 'flexible' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_setting')).toBe(true)
  })

  it('allows multiple distinct settings', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { setting_id: 'ssl', value: 'full' } },
        { name: 'b', fields: { setting_id: 'min_tls_version', value: '1.2' } },
        { name: 'c', fields: { setting_id: 'always_use_https', value: 'on' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('settingKey folds case and extractZoneSettingSpecs trims fields', () => {
    expect(settingKey('  SSL  ')).toBe('ssl')
    const specs = extractZoneSettingSpecs(
      makeCtx([{ name: 's', fields: { setting_id: '  security_level  ', value: '  medium  ' } }]).canvas,
    )
    expect(specs[0].settingId).toBe('security_level')
    expect(specs[0].value).toBe('medium')
  })

  it('normalizeSettingValue stringifies non-string live values', () => {
    expect(normalizeSettingValue('on')).toBe('on')
    expect(normalizeSettingValue(true)).toBe('true')
    expect(normalizeSettingValue(undefined)).toBe('')
    expect(normalizeSettingValue({ strict: 'on' })).toBe('{"strict":"on"}')
  })
})
