import validate, { extractIndicatorSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'defender-endpoint',
    customerId: 'cust-1',
    configTypeId: 'mde-file-indicators',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'defender-endpoint',
      entityType: 'mde-file-indicators',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: '00000000-0000-0000-0000-000000000000' },
    platform: stubPlatform,
  }
}

const SHA256 = 'a'.repeat(64)
const SHA1 = 'b'.repeat(40)
const MD5 = 'c'.repeat(32)
const base = { title: 'Bad file', description: 'Known-bad', generate_alert: true }

describe('Defender File Indicators Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates SHA-256 / SHA-1 / MD5 hashes', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { indicator_type: 'FileSha256', indicator_value: SHA256, action: 'Block', ...base } },
        { name: 'b', fields: { indicator_type: 'FileSha1', indicator_value: SHA1, action: 'Block', ...base } },
        { name: 'c', fields: { indicator_type: 'FileMd5', indicator_value: MD5, action: 'Block', ...base } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a wrong-length hash', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { indicator_type: 'FileSha256', indicator_value: 'abc123', action: 'Block', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects a non-hex hash', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { indicator_type: 'FileMd5', indicator_value: 'z'.repeat(32), action: 'Block', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects an out-of-type value (URL in file canvas)', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { indicator_type: 'Url', indicator_value: 'https://x.io', action: 'Block', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects duplicate hashes case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { indicator_type: 'FileSha256', indicator_value: SHA256, action: 'Block', ...base } },
        { name: 'b', fields: { indicator_type: 'FileSha256', indicator_value: SHA256.toUpperCase(), action: 'Block', ...base } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_indicator')).toBe(true)
  })

  it('extract behaves', () => {
    const specs = extractIndicatorSpecs(makeCtx([{ name: 't', fields: { indicator_type: 'FileSha256', indicator_value: `  ${SHA256}  ` } }]).canvas)
    expect(specs[0].indicatorValue).toBe(SHA256)
  })
})
