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
    configTypeId: 'indexes',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk',
      entityType: 'indexes',
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

  // Splunk allows index names to start with a digit — only leading
  // underscores and hyphens are forbidden.
  it('accepts index name starting with a number', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '123abc' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects index name starting with an underscore', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '_myindex' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects index name starting with a hyphen', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '-myindex' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects index names containing "kvstore"', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'appkvstore' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_substring')).toBe(true)
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

  it('rejects the _configtracker internal index', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '_configtracker' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('warns when managing a built-in index', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'main' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'builtin_index')).toBe(true)
  })

  it('detects duplicate index names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'dup-idx' } },
        { name: 'sec2', fields: { name: 'dup-idx' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('rejects invalid datatype', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', datatype: 'logs' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_datatype')).toBe(true)
  })

  it('accepts metric datatype', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', datatype: 'metric' } }]))
    expect(result.valid).toBe(true)
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

  it('rejects invalid bucket size mode', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', maxDataSizeMode: 'huge' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects custom bucket size outside Splunk maxDataSize range', async () => {
    const tooSmall = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', maxDataSizeMode: 'custom', maxDataSizeCustomMB: 50 } }]),
    )
    expect(tooSmall.valid).toBe(false)
    expect(tooSmall.errors.some((e) => e.code === 'range')).toBe(true)

    const tooLarge = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', maxDataSizeMode: 'custom', maxDataSizeCustomMB: 2_000_000 } }]),
    )
    expect(tooLarge.valid).toBe(false)
    expect(tooLarge.errors.some((e) => e.code === 'range')).toBe(true)
  })

  it('accepts auto_high_volume bucket size mode', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', maxDataSizeMode: 'auto_high_volume' } }]),
    )
    expect(result.valid).toBe(true)
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

  it('warns when short retention has no frozen archive directory', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', frozenTimeDays: 14 } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_frozen_archive')).toBe(true)
  })

  it('does not warn about frozen archive when coldToFrozenDir is set', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', frozenTimeDays: 14, coldToFrozenDir: '/archive/frozen' } }]),
    )
    expect(result.warnings.some((w) => w.code === 'no_frozen_archive')).toBe(false)
  })

  it('rejects thawedPath using a volume reference', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', thawedPath: 'volume:cold/myidx/thaweddb' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_volume_path')).toBe(true)
  })

  it('warns on hardcoded homePath', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', homePath: '/data/splunk/myidx/db' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'nonstandard_path')).toBe(true)
  })

  it('accepts volume-based homePath without warning', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', homePath: 'volume:hot/valid-idx/db' } }]),
    )
    expect(result.warnings.some((w) => w.code === 'nonstandard_path')).toBe(false)
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

  it('warns on aggressive TSIDX reduction period', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', enableTsidxReduction: true, tsidxReductionPeriodDays: 3 } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'aggressive_tsidx_reduction')).toBe(true)
  })

  it('rejects non-positive TSIDX reduction period', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', enableTsidxReduction: true, tsidxReductionPeriodDays: 0 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
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
