import validate, { extractAssetGroupSpecs, assetGroupKey } from '../validate'
import { buildAddParams, buildEditParams, parseAssetGroupBlock, normalizeIps } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'qualys',
    customerId: 'cust-1',
    configTypeId: 'qualys-asset-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'qualys',
      entityType: 'qualys-asset-groups',
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

describe('Qualys Asset Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal asset group (title only)', async () => {
    const result = await validate(makeCtx([{ name: 'Group', fields: { title: 'Prod DB' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a full asset group', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Group',
          fields: {
            title: 'Web Tier',
            ips: '10.0.0.1-10.0.0.254, 192.168.1.10',
            business_impact: 'high',
            division: 'IT',
            location: 'us-east',
            comments: 'external web',
            network_id: 5,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing title', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { comments: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('title'))).toBe(true)
  })

  it('rejects the reserved title "All"', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { title: 'all' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_title')).toBe(true)
  })

  it('rejects an unsupported business impact', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { title: 'x', business_impact: 'nope' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects a non-integer network id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { title: 'x', network_id: 'abc' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_network_id')).toBe(true)
  })

  it('rejects duplicate titles case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { title: 'DB' } },
        { name: 'b', fields: { title: 'db' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_asset_group')).toBe(true)
  })

  it('extract trims fields and buildAddParams omits blanks + normalizes ips', () => {
    const specs = extractAssetGroupSpecs(
      makeCtx([{ name: 't', fields: { title: '  Web  ', comments: ' c ', ips: '10.0.0.1  10.0.0.2, 10.0.0.3' } }]).canvas,
    )
    expect(specs[0].title).toBe('Web')
    expect(specs[0].comments).toBe('c')
    expect(assetGroupKey(specs[0])).toBe(assetGroupKey({ title: 'web' }))

    const add = buildAddParams(specs[0])
    expect(add.action).toBe('add')
    expect(add.title).toBe('Web')
    expect(add.ips).toBe('10.0.0.1,10.0.0.2,10.0.0.3')
    expect(add.business_impact).toBeUndefined()

    const edit = buildEditParams(specs[0], '123')
    expect(edit.action).toBe('edit')
    expect(edit.id).toBe('123')
    expect(edit.set_title).toBe('Web')
    expect(edit.set_ips).toBe('10.0.0.1,10.0.0.2,10.0.0.3')
  })

  it('normalizeIps splits on commas and whitespace', () => {
    expect(normalizeIps(' 1.1.1.1 ,2.2.2.2\n3.3.3.3 ')).toBe('1.1.1.1,2.2.2.2,3.3.3.3')
    expect(normalizeIps('   ')).toBe('')
  })

  it('parseAssetGroupBlock reads id/title/impact/ips from an ASSET_GROUP block', () => {
    const block =
      '<ID>101</ID><TITLE>Web Tier</TITLE><BUSINESS_IMPACT>High</BUSINESS_IMPACT>' +
      '<COMMENTS>ext</COMMENTS><NETWORK_ID>0</NETWORK_ID>' +
      '<IP_SET><IP>10.0.0.5</IP><IP_RANGE>10.0.0.1-10.0.0.4</IP_RANGE></IP_SET>'
    const g = parseAssetGroupBlock(block)
    expect(g.id).toBe('101')
    expect(g.title).toBe('Web Tier')
    expect(g.businessImpact).toBe('high')
    expect(g.comments).toBe('ext')
    expect(g.ips).toEqual(['10.0.0.5', '10.0.0.1-10.0.0.4'])
  })
})
