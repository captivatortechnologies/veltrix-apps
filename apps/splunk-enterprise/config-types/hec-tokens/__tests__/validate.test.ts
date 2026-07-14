import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-enterprise',
    customerId: 'cust-1',
    configTypeId: 'hec-tokens',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test HEC Canvas',
      toolType: 'splunk',
      entityType: 'hec-tokens',
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

describe('Splunk HEC Tokens Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully specified token', async () => {
    const result = await validate(
      makeCtx([{
        name: 'sec1',
        fields: {
          name: 'firewall-ingest',
          defaultIndex: 'firewall',
          allowedIndexes: ['firewall', 'security'],
          defaultSourcetype: 'pan:traffic',
          useACK: true,
          enabled: true,
        },
      }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing token name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects invalid token name format', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'bad token!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects token name exceeding max length', async () => {
    const longName = 'a' + 'b'.repeat(80)
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: longName } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('detects duplicate token names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'dup-token', allowedIndexes: ['main'] } },
        { name: 'sec2', fields: { name: 'dup-token', allowedIndexes: ['main'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('rejects invalid index names in the allow-list', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'token-1', allowedIndexes: ['_internal-ish!'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects a default index outside the allow-list', async () => {
    const result = await validate(
      makeCtx([{
        name: 'sec1',
        fields: { name: 'token-1', defaultIndex: 'other', allowedIndexes: ['firewall', 'security'] },
      }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'index_not_allowed')).toBe(true)
  })

  it('warns when no index restriction is set', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'token-1', defaultIndex: 'main' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'unrestricted_indexes')).toBe(true)
  })

  it('warns when no default index is set', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'token-1', allowedIndexes: ['security'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_default_index')).toBe(true)
  })

  it('rejects non-boolean useACK', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'token-1', allowedIndexes: ['main'], defaultIndex: 'main', useACK: 'yes' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })
})
