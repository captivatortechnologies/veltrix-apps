import validate, {
  extractCaptchaSpecs,
  preserveSecret,
  toStringList,
} from '../validate'
import {
  buildInstanceBody,
  stripReadOnlyCaptchaFields,
  type CaptchaRollbackData,
} from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'captcha',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'captcha',
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
    entityType: 'captcha',
    items: sections,
    sections,
    snapshot: {},
  }
}

const valid = {
  name: 'Org hCaptcha',
  type: 'HCAPTCHA',
  siteKey: 'site-123',
  secretKey: 'secret-abc',
  enabledPages: ['SIGN_IN', 'SSPR'],
}

describe('Okta CAPTCHA Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a full valid config', async () => {
    const result = await validate(makeCtx([{ name: 'CAPTCHA', fields: valid }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a config with no enabled pages (disabled org-wide)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...valid, enabledPages: [] } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing secret key (write-only, required)', async () => {
    const { secretKey, ...noSecret } = valid
    void secretKey
    const result = await validate(makeCtx([{ name: 'sec1', fields: noSecret }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('secretKey'))).toBe(true)
  })

  it('rejects an invalid provider', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...valid, type: 'FUNCAPTCHA' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an unknown enabled page', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...valid, enabledPages: ['DASHBOARD'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_page')).toBe(true)
  })

  it('rejects a missing site key', async () => {
    const { siteKey, ...noSite } = valid
    void siteKey
    const result = await validate(makeCtx([{ name: 'sec1', fields: noSite }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('siteKey'))).toBe(true)
  })

  it('rejects more than one configuration (singleton)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: valid },
        { name: 'sec2', fields: valid },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'singleton')).toBe(true)
  })
})

describe('extractCaptchaSpecs', () => {
  it('upper-cases type and pages, preserves the secret, de-dupes pages', () => {
    const specs = extractCaptchaSpecs(
      makeCanvas([
        { name: 'sec1', fields: { name: ' A ', type: ' hcaptcha ', siteKey: ' s ', secretKey: ' k ', enabledPages: ['sign_in', 'sign_in', 'sspr'] } },
      ]),
    )
    expect(specs[0].type).toBe('HCAPTCHA')
    expect(specs[0].enabledPages).toEqual(['SIGN_IN', 'SSPR'])
    // secret is preserved verbatim (leading/trailing spaces kept for a real token)
    expect(specs[0].secretKey).toBe(' k ')
    expect(specs[0].name).toBe('A')
  })
})

describe('buildInstanceBody', () => {
  it('includes the write-only secret only when set', () => {
    expect(
      buildInstanceBody({ sectionName: 's', name: 'A', type: 'HCAPTCHA', siteKey: 'sk', secretKey: 'sec', enabledPages: [] }),
    ).toEqual({ name: 'A', type: 'HCAPTCHA', siteKey: 'sk', secretKey: 'sec' })
    expect(
      buildInstanceBody({ sectionName: 's', name: 'A', type: 'HCAPTCHA', siteKey: 'sk', enabledPages: [] }),
    ).toEqual({ name: 'A', type: 'HCAPTCHA', siteKey: 'sk' })
  })
})

describe('stripReadOnlyCaptchaFields', () => {
  it('drops id and _links but keeps name/type/siteKey', () => {
    expect(
      stripReadOnlyCaptchaFields({ id: 'x', _links: {}, name: 'A', type: 'HCAPTCHA', siteKey: 'sk' }),
    ).toEqual({ name: 'A', type: 'HCAPTCHA', siteKey: 'sk' })
  })
})

describe('helpers', () => {
  it('preserveSecret blanks whitespace-only, toStringList splits', () => {
    expect(preserveSecret('   ')).toBeUndefined()
    expect(preserveSecret('abc')).toBe('abc')
    expect(toStringList('SIGN_IN, SSPR')).toEqual(['SIGN_IN', 'SSPR'])
  })
})

// Type-only reference so the rollback data shape stays in sync with deploy.
const _rollbackDataType: CaptchaRollbackData | null = null
void _rollbackDataType
