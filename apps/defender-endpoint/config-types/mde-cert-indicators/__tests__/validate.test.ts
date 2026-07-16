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
    configTypeId: 'mde-cert-indicators',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'defender-endpoint',
      entityType: 'mde-cert-indicators',
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

const THUMB = 'd'.repeat(40)
const base = { title: 'Bad cert', description: 'Revoked signer', generate_alert: true }

describe('Defender Certificate Indicators Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a 40-hex thumbprint', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { indicator_type: 'CertificateThumbprint', indicator_value: THUMB, action: 'Block', ...base } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a wrong-length thumbprint', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { indicator_type: 'CertificateThumbprint', indicator_value: 'abcd', action: 'Block', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects an out-of-type value (file hash in cert canvas)', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { indicator_type: 'FileSha256', indicator_value: 'a'.repeat(64), action: 'Block', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects duplicate thumbprints', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { indicator_type: 'CertificateThumbprint', indicator_value: THUMB, action: 'Block', ...base } },
        { name: 'b', fields: { indicator_type: 'CertificateThumbprint', indicator_value: THUMB.toUpperCase(), action: 'Block', ...base } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_indicator')).toBe(true)
  })

  it('extract behaves', () => {
    const specs = extractIndicatorSpecs(makeCtx([{ name: 't', fields: { indicator_type: 'CertificateThumbprint', indicator_value: `  ${THUMB}  ` } }]).canvas)
    expect(specs[0].indicatorValue).toBe(THUMB)
  })
})
