import validate, { extractMtlsCertificateSpecs, mtlsCertificateKey, parseHostnames } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-access-mtls-certificates',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-access-mtls-certificates',
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

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----'

describe('Cloudflare Access mTLS Certificates Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid certificate', async () => {
    const result = await validate(
      makeCtx([{ name: 'c1', fields: { name: 'Corp Root CA', certificate: PEM, associated_hostnames: 'admin.example.com' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'c1', fields: { certificate: PEM, associated_hostnames: 'admin.example.com' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing certificate', async () => {
    const result = await validate(makeCtx([{ name: 'c1', fields: { name: 'Corp Root CA', associated_hostnames: 'admin.example.com' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('certificate'))).toBe(true)
  })

  it('rejects a certificate that is not PEM-encoded', async () => {
    const result = await validate(
      makeCtx([{ name: 'c1', fields: { name: 'Corp Root CA', certificate: 'not a cert', associated_hostnames: 'admin.example.com' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_certificate')).toBe(true)
  })

  it('rejects a missing associated hostname', async () => {
    const result = await validate(makeCtx([{ name: 'c1', fields: { name: 'Corp Root CA', certificate: PEM } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('associated_hostnames'))).toBe(true)
  })

  it('rejects duplicate certificate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Corp Root CA', certificate: PEM, associated_hostnames: 'a.example.com' } },
        { name: 'b', fields: { name: 'corp root ca', certificate: PEM, associated_hostnames: 'b.example.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_certificate')).toBe(true)
  })

  it('extractMtlsCertificateSpecs trims fields and parses multi-line hostnames', () => {
    const specs = extractMtlsCertificateSpecs(
      makeCtx([{ name: 'r', fields: { name: '  Corp Root CA  ', certificate: PEM, associated_hostnames: 'a.example.com\n\nb.example.com\n' } }])
        .canvas,
    )
    expect(specs[0].name).toBe('Corp Root CA')
    expect(specs[0].associatedHostnames).toEqual(['a.example.com', 'b.example.com'])
  })

  it('mtlsCertificateKey folds case and parseHostnames ignores blank lines', () => {
    expect(mtlsCertificateKey('Corp Root CA')).toBe(mtlsCertificateKey('  corp root ca  '))
    expect(parseHostnames('a.com\n \nb.com')).toEqual(['a.com', 'b.com'])
    expect(parseHostnames(undefined)).toEqual([])
  })
})
