import validate, { extractIpSourceGroupSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-ip-source-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-ip-source-groups',
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

describe('ZIA IP Source Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid IP source group', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'IP Source Group',
          fields: { name: 'Corp Sources', description: 'Corporate ranges', ip_addresses: '10.0.0.0/8\n192.168.1.1' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ip_addresses: '10.0.0.1' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256), ip_addresses: '10.0.0.1' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Sources', ip_addresses: '10.0.0.1' } },
        { name: 'b', fields: { name: 'sources', ip_addresses: '10.0.0.2' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_ip_source_group')).toBe(true)
  })

  it('rejects a group with no IP addresses', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Empty Group', ip_addresses: '   \n  ' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('ip_addresses'))).toBe(true)
  })

  it('extractIpSourceGroupSpecs trims lines, drops blanks and blank descriptions', () => {
    const specs = extractIpSourceGroupSpecs(
      makeCtx([
        {
          name: 'IP Source Group',
          fields: { name: '  Sources  ', description: '   ', ip_addresses: '  10.0.0.0/8  \n\n 192.168.1.1 \n' },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Sources')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].ipAddresses).toEqual(['10.0.0.0/8', '192.168.1.1'])
  })
})
