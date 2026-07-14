import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Roles Canvas',
      toolType: 'splunk-cloud',
      entityType: 'roles',
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

describe('Splunk Cloud Roles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully specified role', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'soc-analyst',
            importedRoles: ['user'],
            capabilities: ['search', 'schedule_search'],
            srchIndexesAllowed: ['firewall', 'security'],
            srchIndexesDefault: ['security'],
            srchFilter: 'host=web*',
            srchTimeWin: 86400,
            defaultApp: 'search',
            srchJobsQuota: 5,
            rtSrchJobsQuota: 2,
            srchDiskQuota: 200,
            cumulativeSrchJobsQuota: 20,
            cumulativeRTSrchJobsQuota: 10,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing role name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an uppercase role name (Splunk role names are lowercase)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'SOC-Analyst' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects a role name with spaces or colons', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'soc analyst' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects a role name exceeding max length', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'a'.repeat(101) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate role names across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'dup-role', capabilities: ['search'] } },
        { name: 'sec2', fields: { name: 'dup-role', capabilities: ['search'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects redefining sc_admin (reserved by Splunk Cloud)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'sc_admin', capabilities: ['search'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_role')).toBe(true)
  })

  it('warns when a built-in role is redefined', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'power', capabilities: ['search'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'built_in_role')).toBe(true)
  })

  it('rejects a role that inherits from itself', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', importedRoles: ['soc-analyst'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'self_import')).toBe(true)
  })

  it('rejects an invalid inherited role name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', importedRoles: ['Bad Role'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects an invalid capability name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['Schedule Search'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('warns when a role grants no capabilities and inherits nothing', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'empty-role' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_privileges')).toBe(true)
  })

  it('warns when the role can search every index', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], srchIndexesAllowed: ['*'] } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'unrestricted_indexes')).toBe(true)
  })

  it('rejects a default searched index outside the searchable indexes', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'soc-analyst',
            capabilities: ['search'],
            srchIndexesAllowed: ['firewall'],
            srchIndexesDefault: ['security'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'index_not_allowed')).toBe(true)
  })

  it('accepts a default searched index covered by a wildcard allow entry', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'soc-analyst',
            capabilities: ['search'],
            srchIndexesAllowed: ['sec-*'],
            srchIndexesDefault: ['sec-firewall'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an invalid index name in the searchable indexes', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], srchIndexesAllowed: ['bad index!'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects a search time window below -1', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], srchTimeWin: -5 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('accepts -1 as an unlimited search time window', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], srchTimeWin: -1 } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects an invalid default app', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], defaultApp: 'my app!' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects a negative quota', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], srchJobsQuota: -1 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects a non-integer quota', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], srchDiskQuota: 1.5 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('accepts 0 (unlimited) for the cumulative quotas', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'soc-analyst',
            capabilities: ['search'],
            cumulativeSrchJobsQuota: 0,
            cumulativeRTSrchJobsQuota: 0,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates multiple roles', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'soc-analyst', importedRoles: ['user'], srchIndexesAllowed: ['security'] } },
        { name: 'sec2', fields: { name: 'soc-lead', importedRoles: ['soc-analyst'], capabilities: ['edit_search_schedule_window'] } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})
