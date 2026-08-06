import validate from '../validate'
import { buildCompanyUpdateBody, companyFieldsMatch, companyProfileKey, extractCompanyProfileSpecs } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'bitdefender-gravityzone',
    customerId: 'cust-1',
    configTypeId: 'company-profile',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'bitdefender-gravityzone',
      entityType: 'company-profile',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('GravityZone Company Profile Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed declaration with a blank companyId', async () => {
    const result = await validate(makeCtx([{ name: 'c1', fields: { companyId: '', name: 'Acme Corp' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a well-formed declaration with an explicit companyId', async () => {
    const result = await validate(makeCtx([{ name: 'c1', fields: { companyId: 'company-1', name: 'Acme Corp' } }]))
    expect(result.valid).toBe(true)
  })

  it('warns when two declarations both leave companyId blank', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { companyId: '' } }, { name: 'b', fields: { companyId: '' } }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_COMPANY')).toBe(true)
  })

  it('warns on a duplicate explicit companyId', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { companyId: 'company-1' } }, { name: 'b', fields: { companyId: 'company-1' } }]),
    )
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_COMPANY')).toBe(true)
  })

  it('rejects malformed contactPerson JSON', async () => {
    const result = await validate(makeCtx([{ name: 'c1', fields: { companyId: '', contactPerson: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('rejects malformed mdrContactInformation JSON', async () => {
    const result = await validate(makeCtx([{ name: 'c1', fields: { companyId: '', mdrContactInformation: '[not-obj]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })
})

describe('GravityZone Company Profile shared helpers', () => {
  it('companyProfileKey trims and lower-cases', () => {
    expect(companyProfileKey('  Company-1  ')).toBe('company-1')
  })

  it('extractCompanyProfileSpecs reads only declared (non-blank) fields', () => {
    const specs = extractCompanyProfileSpecs(makeCtx([{ name: 'c', fields: { companyId: '', name: 'Acme', enforce2FA: true } }]).canvas)
    expect(specs[0].name).toBe('Acme')
    expect(specs[0].enforce2FADeclared).toBe(true)
    expect(specs[0].enforce2FA).toBe(true)
    expect(specs[0].address).toBe('')
  })

  it('buildCompanyUpdateBody omits undeclared (blank) fields', () => {
    const specs = extractCompanyProfileSpecs(makeCtx([{ name: 'c', fields: { companyId: '', name: 'Acme' } }]).canvas)
    const body = buildCompanyUpdateBody(specs[0], null, null)
    expect(body).toEqual({ name: 'Acme' })
  })

  it('companyFieldsMatch only compares fields the spec declared', () => {
    const specs = extractCompanyProfileSpecs(makeCtx([{ name: 'c', fields: { companyId: '', name: 'Acme' } }]).canvas)
    expect(companyFieldsMatch(specs[0], null, null, { name: 'Acme', address: 'anything' })).toBe(true)
    expect(companyFieldsMatch(specs[0], null, null, { name: 'Other Co' })).toBe(false)
  })
})
