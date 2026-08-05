import validate, { extractUserSpecs, userKey, parseNames } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-users',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-users',
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

describe('InsightVM Users Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a full user', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'User',
          fields: {
            login: 'jdoe',
            name: 'Jane Doe',
            email: 'jane.doe@example.com',
            password: 'Sup3rSecret!',
            role_id: 'site-admin',
            site_names: 'DMZ\nCorp',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects a missing login, name, role id and password', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('login'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('role_id'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('password'))).toBe(true)
  })

  it('rejects a malformed email', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { login: 'x', name: 'X', role_id: 'user', password: 'p', email: 'not-an-email' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_email')).toBe(true)
  })

  it('warns when site/asset group names are declared alongside all-access flags', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            login: 'x',
            name: 'X',
            role_id: 'global-admin',
            password: 'p',
            all_sites: true,
            site_names: 'DMZ',
            all_asset_groups: true,
            asset_group_names: 'Servers',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'redundant_site_names')).toBe(true)
    expect(result.warnings.some((w) => w.code === 'redundant_asset_group_names')).toBe(true)
  })

  it('rejects a duplicate login case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { login: 'JDoe', name: 'Jane', role_id: 'user', password: 'p' } },
        { name: 'b', fields: { login: 'jdoe', name: 'Jane 2', role_id: 'user', password: 'p2' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_user')).toBe(true)
  })

  it('extract + helpers behave', () => {
    expect(parseNames('  ')).toEqual([])
    expect(parseNames('DMZ\n  Corp  \n\nLab')).toEqual(['DMZ', 'Corp', 'Lab'])
    const specs = extractUserSpecs(
      makeCtx([
        {
          name: 's',
          fields: {
            login: '  JDoe  ',
            name: '  Jane Doe  ',
            role_id: 'site-admin',
            password: '  Sup3rSecret!  ',
            all_sites: 'true',
            superuser: 'false',
            auth_source_id: '3',
          },
        },
      ]).canvas,
    )
    expect(specs[0].login).toBe('JDoe')
    expect(specs[0].name).toBe('Jane Doe')
    expect(specs[0].password).toBe('Sup3rSecret!')
    expect(specs[0].allSites).toBe(true)
    expect(specs[0].superuser).toBe(false)
    expect(specs[0].authSourceId).toBe(3)
    expect(userKey(specs[0])).toBe('jdoe')
    // Defaults when omitted.
    const defaults = extractUserSpecs(makeCtx([{ name: 's', fields: { login: 'a', name: 'A', role_id: 'user', password: 'p' } }]).canvas)
    expect(defaults[0].enabled).toBe(true)
    expect(defaults[0].allSites).toBe(false)
    expect(defaults[0].allAssetGroups).toBe(false)
    expect(defaults[0].superuser).toBe(false)
    expect(defaults[0].passwordResetOnLogin).toBe(false)
  })
})
