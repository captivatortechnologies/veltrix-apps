import validate, { extractServerGroupSpecs, readBool, splitLines } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zpa-server-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zpa-server-groups',
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

describe('ZPA Server Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid server group (dynamic discovery on)', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Server Group',
          fields: { name: 'Corp Servers', enabled: true, app_connector_groups: 'East DC\nWest DC' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { app_connector_groups: 'East DC' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Corp Servers', app_connector_groups: 'East DC' } },
        { name: 'b', fields: { name: 'corp servers', app_connector_groups: 'West DC' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_server_group')).toBe(true)
  })

  it('requires at least one App Connector group', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Corp Servers' } }]))
    expect(result.valid).toBe(false)
    expect(
      result.errors.some((e) => e.code === 'required' && e.field.includes('app_connector_groups')),
    ).toBe(true)
  })

  it('requires at least one server when dynamic discovery is off', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a',
          fields: { name: 'Corp Servers', dynamic_discovery: false, app_connector_groups: 'East DC' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('servers'))).toBe(true)
  })

  it('accepts dynamic discovery off when servers are listed', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a',
          fields: {
            name: 'Corp Servers',
            dynamic_discovery: false,
            app_connector_groups: 'East DC',
            servers: 'db-1.corp.example\ndb-2.corp.example',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('defaults enabled and dynamic_discovery to true and parses member lines', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(splitLines('a\n\n b \n')).toEqual(['a', 'b'])
    const specs = extractServerGroupSpecs(
      makeCtx([{ name: 'g', fields: { name: 'X', app_connector_groups: 'East DC' } }]).canvas,
    )
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].dynamicDiscovery).toBe(true)
    expect(specs[0].appConnectorGroups).toEqual(['East DC'])
  })
})
