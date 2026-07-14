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
    configTypeId: 'indexes',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-cloud',
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

describe('Splunk Cloud Indexes Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid index configuration', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Index',
          fields: { name: 'app-logs', datatype: 'event', searchableDays: 90, maxDataSizeMB: 512 },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts an index name starting with a number (Splunk Cloud allows it)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '1stparty-logs' } }]))
    expect(result.valid).toBe(true)
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

  it('rejects internal index names (leading underscore)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '_internal' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects index name exceeding max length', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'a'.repeat(81) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate index names across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'dup-index' } },
        { name: 'sec2', fields: { name: 'dup-index' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects invalid datatype', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', datatype: 'metrics' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_datatype')).toBe(true)
  })

  it('accepts metric datatype', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', datatype: 'metric' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects non-positive searchableDays', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', searchableDays: 0 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('warns on very long searchable retention', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', searchableDays: 4000 } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'long_retention')).toBe(true)
  })

  it('rejects negative maxDataSizeMB', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', maxDataSizeMB: -1 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('accepts maxDataSizeMB of 0 (unlimited, the ACS default)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', maxDataSizeMB: 0 } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns on very large maxDataSizeMB', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', maxDataSizeMB: 2_000_000 } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'large_value')).toBe(true)
  })

  it('rejects archival retention above the ACS maximum', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'valid-idx', splunkArchivalRetentionDays: 4000 } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'range')).toBe(true)
  })

  it('rejects archival retention not greater than searchable days', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'valid-idx', searchableDays: 100, splunkArchivalRetentionDays: 100 },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'archival_conflict')).toBe(true)
  })

  it('compares archival retention against the ACS default searchable days when unset', async () => {
    // searchableDays omitted → ACS default of 90; archival of 30 must be rejected
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'valid-idx', splunkArchivalRetentionDays: 30 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'archival_conflict')).toBe(true)
  })

  it('rejects invalid self storage bucket path', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'valid-idx', selfStorageBucketPath: 'http://bucket/x' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('accepts s3 and gs bucket paths', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'idx-a', selfStorageBucketPath: 's3://bucket/folder' } },
        { name: 'sec2', fields: { name: 'idx-b', selfStorageBucketPath: 'gs://bucket/folder' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects combining DDAA and DDSS on one index', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'valid-idx',
            searchableDays: 90,
            splunkArchivalRetentionDays: 365,
            selfStorageBucketPath: 's3://bucket/folder',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'storage_conflict')).toBe(true)
  })

  it('validates multiple sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'idx-one', searchableDays: 30 } },
        { name: 'sec2', fields: { name: 'idx-two', datatype: 'metric', maxDataSizeMB: 1024 } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})
