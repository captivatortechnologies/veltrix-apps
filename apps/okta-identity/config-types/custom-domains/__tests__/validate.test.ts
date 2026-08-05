import validate, {
  buildBrandBody,
  buildCertificateBody,
  buildCreateBody,
  CERTIFICATE_SOURCE_TYPES,
  CERTIFICATE_TYPE,
  extractCustomDomainSpecs,
  hasAnyCertMaterial,
  hasFullCertMaterial,
  isManualCertificate,
  MAX_DOMAIN_NAME_LENGTH,
} from '../validate'
import { type CustomDomainRollbackEntry } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'custom-domains',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'custom-domains',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'okta-identity',
    entityType: 'custom-domains',
    items: sections,
    sections,
    snapshot: {},
  }
}

const oktaManagedFields = {
  domain: 'login.acme.com',
  brandId: 'bnd123',
  certificateSourceType: 'OKTA_MANAGED',
}

const manualFields = {
  domain: 'login.acme.com',
  brandId: 'bnd123',
  certificateSourceType: 'MANUAL',
  certificate: 'FAKE-CERTIFICATE-PEM-CONTENT-FOR-TESTING-ONLY',
  certificateChain: 'FAKE-CERTIFICATE-CHAIN-PEM-CONTENT-FOR-TESTING-ONLY',
  privateKey: 'FAKE-PRIVATE-KEY-PEM-CONTENT-FOR-TESTING-ONLY',
}

describe('Okta Custom Domains Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a full valid OKTA_MANAGED config', async () => {
    const result = await validate(makeCtx([{ name: 'Domain1', fields: oktaManagedFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('validates a full valid MANUAL config with complete certificate material', async () => {
    const result = await validate(makeCtx([{ name: 'Domain1', fields: manualFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects a missing domain', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { certificateSourceType: 'OKTA_MANAGED' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('domain'))).toBe(true)
  })

  it('rejects a domain longer than the max length', async () => {
    const longDomain = `${'a'.repeat(300)}.com`
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...oktaManagedFields, domain: longDomain } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate domains (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { ...oktaManagedFields, domain: 'login.acme.com' } },
        { name: 'sec2', fields: { ...oktaManagedFields, domain: 'LOGIN.ACME.COM' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_domain')).toBe(true)
  })

  it('warns (does not error) on a non-hostname-looking domain', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...oktaManagedFields, domain: 'not a domain' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'suspicious_domain')).toBe(true)
  })

  it('rejects an invalid certificateSourceType', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...oktaManagedFields, certificateSourceType: 'BOGUS' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_certificate_source')).toBe(true)
  })

  it('errors on MANUAL with partial certificate material', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { ...oktaManagedFields, certificateSourceType: 'MANUAL', certificate: 'cert-only' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'incomplete_certificate')).toBe(true)
  })

  it('warns on MANUAL with no certificate material (valid for an update)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...oktaManagedFields, certificateSourceType: 'MANUAL' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_certificate')).toBe(true)
  })

  it('warns when certificate fields are set on an OKTA_MANAGED domain', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...oktaManagedFields, certificate: 'stray-cert' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'certificate_ignored')).toBe(true)
  })
})

describe('extractCustomDomainSpecs', () => {
  it('trims fields and defaults certificateSourceType to OKTA_MANAGED', () => {
    const specs = extractCustomDomainSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { domain: '  login.acme.com  ', brandId: ' bnd123 ' },
        },
      ]),
    )
    expect(specs[0].domain).toBe('login.acme.com')
    expect(specs[0].brandId).toBe('bnd123')
    expect(specs[0].certificateSourceType).toBe('OKTA_MANAGED')
  })

  it('preserves certificate material exactly (whitespace-sensitive PEM)', () => {
    const specs = extractCustomDomainSpecs(makeCanvas([{ name: 'sec1', fields: manualFields }]))
    expect(specs[0].certificate).toBe(manualFields.certificate)
    expect(specs[0].certificateChain).toBe(manualFields.certificateChain)
    expect(specs[0].privateKey).toBe(manualFields.privateKey)
  })

  it('treats whitespace-only certificate fields as blank', () => {
    const specs = extractCustomDomainSpecs(
      makeCanvas([{ name: 'sec1', fields: { ...oktaManagedFields, certificate: '   ' } }]),
    )
    expect(specs[0].certificate).toBeUndefined()
  })
})

describe('hasAnyCertMaterial / hasFullCertMaterial', () => {
  it('hasAnyCertMaterial is true when at least one field is set', () => {
    const [spec] = extractCustomDomainSpecs(
      makeCanvas([{ name: 'sec1', fields: { ...oktaManagedFields, certificate: 'x' } }]),
    )
    expect(hasAnyCertMaterial(spec)).toBe(true)
    expect(hasFullCertMaterial(spec)).toBe(false)
  })

  it('hasFullCertMaterial is true only when all three are set', () => {
    const [spec] = extractCustomDomainSpecs(makeCanvas([{ name: 'sec1', fields: manualFields }]))
    expect(hasFullCertMaterial(spec)).toBe(true)
  })
})

describe('isManualCertificate', () => {
  it('is case-insensitive', () => {
    expect(isManualCertificate('manual')).toBe(true)
    expect(isManualCertificate('MANUAL')).toBe(true)
    expect(isManualCertificate('OKTA_MANAGED')).toBe(false)
  })
})

describe('buildCreateBody', () => {
  it('carries only domain + certificateSourceType (Okta DomainRequest accepts nothing else)', () => {
    const [spec] = extractCustomDomainSpecs(makeCanvas([{ name: 'sec1', fields: manualFields }]))
    const body = buildCreateBody(spec)
    expect(body).toEqual({ domain: 'login.acme.com', certificateSourceType: 'MANUAL' })
  })
})

describe('buildBrandBody', () => {
  it('carries only brandId (Okta UpdateDomain accepts nothing else)', () => {
    expect(buildBrandBody('bnd999')).toEqual({ brandId: 'bnd999' })
  })
})

describe('buildCertificateBody', () => {
  it('carries type PEM + the three certificate fields', () => {
    const [spec] = extractCustomDomainSpecs(makeCanvas([{ name: 'sec1', fields: manualFields }]))
    const body = buildCertificateBody(spec)
    expect(body).toEqual({
      type: CERTIFICATE_TYPE,
      certificate: manualFields.certificate,
      certificateChain: manualFields.certificateChain,
      privateKey: manualFields.privateKey,
    })
  })
})

describe('constants', () => {
  it('exposes the two certificate source types', () => {
    expect(CERTIFICATE_SOURCE_TYPES).toEqual(['OKTA_MANAGED', 'MANUAL'])
  })

  it('caps the domain name length', () => {
    expect(MAX_DOMAIN_NAME_LENGTH).toBe(255)
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: CustomDomainRollbackEntry | null = null
void _rollbackEntryType
