import validate, { extractDestinationGroupSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-ip-destination-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-ip-destination-groups',
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

describe('ZIA IP Destination Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid destination group', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Destination Group',
          fields: { name: 'Blocked Destinations', type: 'DSTN_IP', addresses: '203.0.113.0/24\n198.51.100.5' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'DSTN_IP', addresses: '10.0.0.1' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'No Type', addresses: '10.0.0.1' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects missing addresses', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'No Addresses', type: 'DSTN_IP' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('addresses'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Blocklist', type: 'DSTN_IP', addresses: '10.0.0.1' } },
        { name: 'b', fields: { name: 'blocklist', type: 'DSTN_FQDN', addresses: 'evil.example.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_ip_destination_group')).toBe(true)
  })

  it('extractDestinationGroupSpecs trims name, splits addresses and drops blank descriptions', () => {
    const specs = extractDestinationGroupSpecs(
      makeCtx([
        {
          name: 'Destination Group',
          fields: {
            name: '  Blocked  ',
            type: 'DSTN_IP',
            addresses: ' 1.1.1.1 \n\n 2.2.2.2 ',
            description: '   ',
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Blocked')
    expect(specs[0].addresses).toEqual(['1.1.1.1', '2.2.2.2'])
    expect(specs[0].description).toBeUndefined()
  })
})
