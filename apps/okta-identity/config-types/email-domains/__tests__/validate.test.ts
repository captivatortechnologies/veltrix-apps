import validate, {
  extractEmailDomainSpecs,
  buildCreateBody,
  buildUpdateBody,
  DEFAULT_VALIDATION_SUBDOMAIN,
} from '../validate'
import { type EmailDomainRollbackEntry } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'email-domains',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'email-domains',
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
    entityType: 'email-domains',
    items: sections,
    sections,
    snapshot: {},
  }
}

const validFields = {
  domain: 'mail.example.com',
  brandId: 'bnd123',
  displayName: 'Acme Security',
  userName: 'no-reply',
  validationSubdomain: 'mail',
}

describe('Okta Email Domains Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a full valid config', async () => {
    const result = await validate(makeCtx([{ name: 'Domain1', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects a missing domain', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { brandId: 'b', displayName: 'd', userName: 'u' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('domain'))).toBe(true)
  })

  it('rejects a missing brandId', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { domain: 'mail.example.com', displayName: 'd', userName: 'u' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('brandId'))).toBe(true)
  })

  it('rejects a missing displayName and userName', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { domain: 'mail.example.com', brandId: 'b' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('displayName'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('userName'))).toBe(true)
  })

  it('rejects duplicate domains (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { ...validFields, domain: 'mail.example.com' } },
        { name: 'sec2', fields: { ...validFields, domain: 'MAIL.EXAMPLE.COM' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_domain')).toBe(true)
  })

  it('warns (does not error) on a non-hostname-looking domain', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, domain: 'not a domain' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'suspicious_domain')).toBe(true)
  })
})

describe('extractEmailDomainSpecs', () => {
  it('trims fields and defaults the validation subdomain', () => {
    const specs = extractEmailDomainSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { domain: '  mail.example.com  ', brandId: ' bnd123 ', displayName: ' Acme ', userName: ' no-reply ' },
        },
      ]),
    )
    expect(specs[0].domain).toBe('mail.example.com')
    expect(specs[0].brandId).toBe('bnd123')
    expect(specs[0].displayName).toBe('Acme')
    expect(specs[0].userName).toBe('no-reply')
    expect(specs[0].validationSubdomain).toBe(DEFAULT_VALIDATION_SUBDOMAIN)
  })
})

describe('buildCreateBody', () => {
  it('carries every field the create endpoint needs', () => {
    const body = buildCreateBody({
      sectionName: 's',
      domain: 'mail.example.com',
      brandId: 'bnd123',
      displayName: 'Acme Security',
      userName: 'no-reply',
      validationSubdomain: 'mail',
    })
    expect(body).toEqual({
      domain: 'mail.example.com',
      brandId: 'bnd123',
      validationSubdomain: 'mail',
      displayName: 'Acme Security',
      userName: 'no-reply',
    })
  })
})

describe('buildUpdateBody', () => {
  it('only sends displayName and userName (the updatable fields)', () => {
    const body = buildUpdateBody({
      sectionName: 's',
      domain: 'mail.example.com',
      brandId: 'bnd123',
      displayName: 'Acme Security',
      userName: 'no-reply',
      validationSubdomain: 'mail',
    })
    expect(body).toEqual({ displayName: 'Acme Security', userName: 'no-reply' })
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: EmailDomainRollbackEntry | null = null
void _rollbackEntryType
