import validate, { accountKey, extractAccountSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-accounts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-accounts',
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

describe('CyberArk Accounts Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid account', async () => {
    const result = await validate(
      makeCtx([
        { name: 'A', fields: { name: 'db-sa', safe_name: 'App-Prod', platform_id: 'MSSQLServer', user_name: 'sa', secret: 's3cr3t' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name, safe and platform id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { user_name: 'sa' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('safe_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('platform_id'))).toBe(true)
  })

  it('rejects invalid platform-properties JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'a', safe_name: 's', platform_id: 'p', platform_account_properties: '{bad json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('requires a manual-management reason when automatic management is off', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'a', safe_name: 's', platform_id: 'p', automatic_management_enabled: false } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('manual_management_reason'))).toBe(true)
  })

  it('rejects duplicate (name, safe) pairs case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'db-sa', safe_name: 'App', platform_id: 'p' } },
        { name: 'b', fields: { name: 'DB-SA', safe_name: 'app', platform_id: 'p' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_account')).toBe(true)
  })

  it('extracts specs with secret + management defaults', () => {
    const specs = extractAccountSpecs(
      makeCtx([
        { name: 's', fields: { name: '  db-sa  ', safe_name: 'App', platform_id: 'MSSQLServer', secret: '  pw  ', secret_type: 'key' } },
      ]).canvas,
    )
    expect(specs[0].name).toBe('db-sa')
    expect(specs[0].secretType).toBe('key')
    expect(specs[0].secret).toBe('pw')
    expect(specs[0].automaticManagementEnabled).toBe(true)
    expect(accountKey(specs[0])).toBe(accountKey({ name: 'DB-SA', safeName: 'app' }))
  })
})
