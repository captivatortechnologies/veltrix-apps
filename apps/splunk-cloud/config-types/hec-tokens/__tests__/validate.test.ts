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
    configTypeId: 'hec-tokens',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-cloud',
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

describe('Splunk Cloud HEC Tokens Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid token configuration', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'HEC Token',
          fields: {
            name: 'firehose-ingest',
            defaultIndex: 'main',
            allowedIndexes: ['main', 'summary'],
          },
        },
      ]),
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
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'bad name!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects token name exceeding max length', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'a'.repeat(101) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate token names across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'dup-token', defaultIndex: 'main' } },
        { name: 'sec2', fields: { name: 'dup-token', defaultIndex: 'main' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a token value stored in the canvas', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'my-token', token: 'a8d0472c-aa9e-4f35-aadb-000000000000' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'token_in_canvas')).toBe(true)
  })

  it('warns when no default index is specified', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'my-token' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_default_index')).toBe(true)
  })

  it('rejects invalid default index name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'my-token', defaultIndex: 'Bad Index' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects invalid names inside allowedIndexes', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'my-token', defaultIndex: 'main', allowedIndexes: ['main', 'BAD!'] },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('accepts allowedIndexes as a comma-separated string', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'my-token', defaultIndex: 'main', allowedIndexes: 'main, summary' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a default index missing from allowedIndexes', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'my-token', defaultIndex: 'main', allowedIndexes: ['summary'] },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'default_not_allowed')).toBe(true)
  })

  it('warns when indexer acknowledgement is enabled', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'my-token', defaultIndex: 'main', useAck: true } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'ack_limited')).toBe(true)
  })

  it('warns when the token is deployed disabled', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'my-token', defaultIndex: 'main', disabled: true } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'deployed_disabled')).toBe(true)
  })

  it('validates multiple sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'token-one', defaultIndex: 'main' } },
        { name: 'sec2', fields: { name: 'token-two', defaultIndex: 'security' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})
