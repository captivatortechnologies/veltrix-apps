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
    configTypeId: 'ddss-self-storage',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-cloud',
      entityType: 'ddss-self-storage',
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

describe('Splunk Cloud DDSS Self Storage Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid self storage location with no warnings', async () => {
    const result = await validate(
      makeCtx([{ name: 'loc1', fields: { title: 'frozen-archive', bucketName: 'my-splunk-frozen-bucket' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('accepts a GCP bucket with an underscore', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'loc1',
          fields: { title: 'gcs-archive', provider: 'gcp', bucketName: 'my_gcs_frozen_bucket', region: 'us-central1' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing title', async () => {
    const result = await validate(makeCtx([{ name: 'l', fields: { bucketName: 'my-splunk-frozen-bucket' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a missing bucket name', async () => {
    const result = await validate(makeCtx([{ name: 'l', fields: { title: 'frozen-archive' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid bucket name', async () => {
    const result = await validate(
      makeCtx([{ name: 'l', fields: { title: 'frozen-archive', bucketName: 'My_Bucket!!' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_bucket_name')).toBe(true)
  })

  it('rejects a bucket name outside the 3–63 character range', async () => {
    const result = await validate(makeCtx([{ name: 'l', fields: { title: 'frozen-archive', bucketName: 'ab' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'bucket_name_length')).toBe(true)
  })

  it('rejects an IP-formatted S3 bucket name', async () => {
    const result = await validate(
      makeCtx([{ name: 'l', fields: { title: 'frozen-archive', bucketName: '192.168.5.4' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'bucket_is_ip')).toBe(true)
  })

  it('rejects a folder with a leading slash', async () => {
    const result = await validate(
      makeCtx([{ name: 'l', fields: { title: 'frozen-archive', bucketName: 'my-frozen-bucket', folder: '/frozen' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_folder')).toBe(true)
  })

  it('rejects an invalid region', async () => {
    const result = await validate(
      makeCtx([{ name: 'l', fields: { title: 'frozen-archive', bucketName: 'my-frozen-bucket', region: 'invalid' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_region')).toBe(true)
  })

  it('rejects an invalid target index name', async () => {
    const result = await validate(
      makeCtx([{ name: 'l', fields: { title: 'frozen-archive', bucketName: 'my-frozen-bucket', targetIndex: 'BadIndex' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_index_name')).toBe(true)
  })

  it('rejects duplicate titles across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'l1', fields: { title: 'dup', bucketName: 'bucket-one' } },
        { name: 'l2', fields: { title: 'dup', bucketName: 'bucket-two' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_title')).toBe(true)
  })

  it('rejects duplicate bucket+folder across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'l1', fields: { title: 'a', bucketName: 'same-frozen-bucket' } },
        { name: 'l2', fields: { title: 'b', bucketName: 'same-frozen-bucket' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_bucket')).toBe(true)
  })

  it('warns (does not block) on a dotted bucket name', async () => {
    const result = await validate(
      makeCtx([{ name: 'l', fields: { title: 'frozen-archive', bucketName: 'my.frozen.bucket' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'bucket_dots')).toBe(true)
  })

  it('warns with a same-region reminder when a region is set', async () => {
    const result = await validate(
      makeCtx([{ name: 'l', fields: { title: 'frozen-archive', bucketName: 'my-frozen-bucket', region: 'us-east-1' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'region_reminder')).toBe(true)
  })

  it('warns on a trailing slash in the folder', async () => {
    const result = await validate(
      makeCtx([{ name: 'l', fields: { title: 'frozen-archive', bucketName: 'my-frozen-bucket', folder: 'frozen/' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'folder_trailing_slash')).toBe(true)
  })

  it('warns that per-index attachment happens via the indexes config type', async () => {
    const result = await validate(
      makeCtx([{ name: 'l', fields: { title: 'frozen-archive', bucketName: 'my-frozen-bucket', targetIndex: 'main' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'index_attach_hint')).toBe(true)
  })
})
