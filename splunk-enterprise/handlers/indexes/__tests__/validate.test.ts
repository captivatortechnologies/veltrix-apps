import validate from '../validate'
import type { PipelineContext } from '../../../../../core/pipeline-engine/types'

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-enterprise',
    customerId: 'cust-1',
    configTypeId: 'indexes',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk',
      entityType: 'indexes',
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
  }
}

describe('Splunk Indexes Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates valid index configuration', async () => {
    const result = await validate(
      makeCtx([{ name: 'main-index', fields: { name: 'my-index', maxDataSizeMB: 500, frozenTimeDays: 90 } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing index name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects invalid index name format', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Invalid Name!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects index name starting with number', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '123abc' } }]))
    expect(result.valid).toBe(false)
  })

  it('rejects index name exceeding max length', async () => {
    const longName = 'a' + 'b'.repeat(80)
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: longName } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects reserved index names', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '_internal' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('rejects negative maxDataSizeMB', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', maxDataSizeMB: -100 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects maxDataSizeMB exceeding limit', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', maxDataSizeMB: 20_000_000 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'range')).toBe(true)
  })

  it('warns on large maxDataSizeMB', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', maxDataSizeMB: 2_000_000 } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'large_value')).toBe(true)
  })

  it('rejects negative frozenTimeDays', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', frozenTimeDays: -1 } }]))
    expect(result.valid).toBe(false)
  })

  it('warns on very short frozen time', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', frozenTimeDays: 3 } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'short_retention')).toBe(true)
  })

  it('warns when searchable period exceeds retention', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', retentionPeriod: 30, searchablePeriod: 60 } }]),
    )
    expect(result.warnings.some((w) => w.code === 'retention_mismatch')).toBe(true)
  })

  it('warns when compression disabled on large index', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', enableCompression: false, maxDataSizeMB: 200_000 } }]),
    )
    expect(result.warnings.some((w) => w.code === 'compression_recommendation')).toBe(true)
  })

  it('validates multiple sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'idx-one', maxDataSizeMB: 100 } },
        { name: 'sec2', fields: { name: 'idx-two', frozenTimeDays: 90 } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})
