import validate, { extractNetworkSpecs, networkKey } from '../validate'
import { buildCreateParams, buildUpdateParams, parseNetworkBlock } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'qualys',
    customerId: 'cust-1',
    configTypeId: 'qualys-networks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'qualys',
      entityType: 'qualys-networks',
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

describe('Qualys Networks Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a network with just a name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'East Coast DC' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Corp' } },
        { name: 'b', fields: { name: 'corp' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_network')).toBe(true)
  })

  it('networkKey lowercases and trims', () => {
    expect(networkKey({ name: ' Corp ' })).toBe(networkKey({ name: 'corp' }))
  })

  it('build params carry the name through create/update', () => {
    const spec = extractNetworkSpecs(makeCtx([{ name: 't', fields: { name: 'Corp' } }]).canvas)[0]
    expect(buildCreateParams(spec)).toEqual({ action: 'create', name: 'Corp' })
    expect(buildUpdateParams(spec, '1103')).toEqual({ action: 'update', id: '1103', name: 'Corp' })
  })

  it('parseNetworkBlock reads id/name from a <NETWORK> block', () => {
    const block = '<ID>7343</ID><NAME><![CDATA[My New Network]]></NAME><SCANNER_APPLIANCE_LIST></SCANNER_APPLIANCE_LIST>'
    const parsed = parseNetworkBlock(block)
    expect(parsed.id).toBe('7343')
    expect(parsed.name).toBe('My New Network')
  })
})
