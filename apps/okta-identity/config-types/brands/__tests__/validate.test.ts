import validate, {
  extractBrandSpecs,
  hasThemeChange,
  parseConfigObject,
  toBoolean,
} from '../validate'
import {
  buildBrandBody,
  buildThemeBody,
  stripReadOnlyBrandFields,
  stripReadOnlyThemeFields,
  type BrandRollbackEntry,
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
    configTypeId: 'brands',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'brands',
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
    entityType: 'brands',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Okta Brands Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a brand with colours and variants', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Brand',
          fields: {
            name: 'Corporate',
            removePoweredByOkta: true,
            primaryColorHex: '#1662dd',
            primaryColorContrastHex: '#000000',
            themeConfigJson: '{"signInPageTouchPointVariant":"OKTA_DEFAULT"}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a minimal brand (name only)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Minimal' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { primaryColorHex: '#123456' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an invalid hex colour', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'B', primaryColorHex: 'blue' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_color')).toBe(true)
  })

  it('rejects a non-https custom privacy policy URL', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'B', customPrivacyPolicyUrl: 'http://x.example', agreeToCustomPrivacyPolicy: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_url')).toBe(true)
  })

  it('warns when a custom privacy policy URL is set without consent', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'B', customPrivacyPolicyUrl: 'https://x.example' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'consent_required')).toBe(true)
  })

  it('rejects a themeConfigJson that is not a JSON object', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'B', themeConfigJson: '[1,2]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_theme_config')).toBe(true)
  })

  it('rejects duplicate brand names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Dup' } },
        { name: 'sec2', fields: { name: 'dup' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractBrandSpecs / hasThemeChange', () => {
  it('extracts fields, coerces booleans, and detects a theme change', () => {
    const specs = extractBrandSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: ' Corp ', removePoweredByOkta: 'true', primaryColorHex: '#1662dd' } }]),
    )
    expect(specs[0].name).toBe('Corp')
    expect(specs[0].removePoweredByOkta).toBe(true)
    expect(hasThemeChange(specs[0])).toBe(true)
  })

  it('reports no theme change when no theme fields are set', () => {
    const specs = extractBrandSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'Corp' } }]))
    expect(hasThemeChange(specs[0])).toBe(false)
  })
})

describe('buildBrandBody', () => {
  it('always sends name + flags, omits blank optionals', () => {
    const body = buildBrandBody({
      sectionName: 's',
      name: 'Corp',
      removePoweredByOkta: true,
      agreeToCustomPrivacyPolicy: false,
    })
    expect(body).toEqual({ name: 'Corp', removePoweredByOkta: true, agreeToCustomPrivacyPolicy: false })
  })
})

describe('buildThemeBody', () => {
  it('falls back to the live colour when a colour is left blank, and merges variants', () => {
    const body = buildThemeBody(
      {
        sectionName: 's',
        name: 'Corp',
        removePoweredByOkta: false,
        agreeToCustomPrivacyPolicy: false,
        primaryColorHex: '#111111',
      },
      { signInPageTouchPointVariant: 'OKTA_DEFAULT' },
      { secondaryColorHex: '#ebebed', primaryColorContrastHex: '#000000' },
    )
    expect(body.primaryColorHex).toBe('#111111')
    expect(body.secondaryColorHex).toBe('#ebebed')
    expect(body.primaryColorContrastHex).toBe('#000000')
    expect(body.signInPageTouchPointVariant).toBe('OKTA_DEFAULT')
  })
})

describe('strip helpers', () => {
  it('drops brand + theme server-managed fields', () => {
    expect(stripReadOnlyBrandFields({ id: 'b', isDefault: true, name: 'C', _links: {} })).toEqual({ name: 'C' })
    expect(stripReadOnlyThemeFields({ id: 't', logo: 'x', primaryColorHex: '#111111', _links: {} })).toEqual({
      primaryColorHex: '#111111',
    })
  })
})

describe('helpers', () => {
  it('toBoolean and parseConfigObject behave', () => {
    expect(toBoolean('true', false)).toBe(true)
    expect(parseConfigObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseConfigObject('[1]')).toBeNull()
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: BrandRollbackEntry | null = null
void _rollbackEntryType
