import validate, { extractNetworkAppGroupSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-network-app-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-network-app-groups',
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

describe('ZIA Network Application Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid network application group', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'App Group',
          fields: { name: 'Corp Apps', description: 'Corporate apps', network_applications: 'APNS\nDNS' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { network_applications: 'APNS' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a group with no network applications', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Corp Apps', network_applications: '   ' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('network_applications'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256), network_applications: 'APNS' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Apps', network_applications: 'APNS' } },
        { name: 'b', fields: { name: 'apps', network_applications: 'DNS' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_network_app_group')).toBe(true)
  })

  it('extractNetworkAppGroupSpecs trims name and splits applications into lines', () => {
    const specs = extractNetworkAppGroupSpecs(
      makeCtx([
        {
          name: 'App Group',
          fields: { name: '  Corp Apps  ', description: '   ', network_applications: 'APNS\n  DNS  \n\n' },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Corp Apps')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].networkApplications).toEqual(['APNS', 'DNS'])
  })
})
