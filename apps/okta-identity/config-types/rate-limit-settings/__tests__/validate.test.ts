import validate, {
  extractRateLimitSpecs,
  toBoolean,
  toNumber,
  INHERIT,
} from '../validate'
import {
  buildAdminNotificationsBody,
  buildPerClientBody,
  stripReadOnly,
  type RateLimitRollbackData,
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
    configTypeId: 'rate-limit-settings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'rate-limit-settings',
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
    entityType: 'rate-limit-settings',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Okta Rate Limit Settings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a full valid config', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'RateLimits',
          fields: {
            adminNotificationsEnabled: true,
            perClientDefaultMode: 'ENFORCE',
            perClientLoginPageMode: 'PREVIEW',
            perClientOAuth2AuthorizeMode: 'INHERIT',
            perClientOIEAppIntentMode: 'INHERIT',
            warningThresholdPercent: 80,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a config with no warning threshold', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { perClientDefaultMode: 'DISABLE' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects an invalid default mode', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { perClientDefaultMode: 'THROTTLE' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_mode' && e.field.includes('perClientDefaultMode'))).toBe(true)
  })

  it('rejects an invalid use-case override', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { perClientDefaultMode: 'ENFORCE', perClientLoginPageMode: 'MAYBE' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_mode' && e.field.includes('perClientLoginPageMode'))).toBe(true)
  })

  it('rejects an out-of-range warning threshold', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { perClientDefaultMode: 'ENFORCE', warningThresholdPercent: 20 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_threshold')).toBe(true)
  })

  it('rejects a non-integer warning threshold', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { perClientDefaultMode: 'ENFORCE', warningThresholdPercent: 55.5 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_threshold')).toBe(true)
  })

  it('rejects more than one configuration (singleton)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { perClientDefaultMode: 'ENFORCE' } },
        { name: 'sec2', fields: { perClientDefaultMode: 'DISABLE' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'singleton')).toBe(true)
  })
})

describe('extractRateLimitSpecs', () => {
  it('upper-cases modes and defaults blanks', () => {
    const specs = extractRateLimitSpecs(
      makeCanvas([{ name: 'sec1', fields: { perClientDefaultMode: ' enforce ' } }]),
    )
    expect(specs[0].perClientDefaultMode).toBe('ENFORCE')
    expect(specs[0].perClientLoginPageMode).toBe(INHERIT)
    expect(specs[0].adminNotificationsEnabled).toBe(true)
    expect(specs[0].warningThresholdPercent).toBeUndefined()
  })
})

describe('buildPerClientBody', () => {
  it('omits INHERIT overrides and always sends useCaseModeOverrides', () => {
    const body = buildPerClientBody({
      sectionName: 's',
      adminNotificationsEnabled: true,
      perClientDefaultMode: 'ENFORCE',
      perClientLoginPageMode: 'PREVIEW',
      perClientOAuth2AuthorizeMode: INHERIT,
      perClientOIEAppIntentMode: 'DISABLE',
    })
    expect(body).toEqual({
      defaultMode: 'ENFORCE',
      useCaseModeOverrides: { LOGIN_PAGE: 'PREVIEW', OIE_APP_INTENT: 'DISABLE' },
    })
  })
})

describe('buildAdminNotificationsBody', () => {
  it('maps the flag to notificationsEnabled', () => {
    expect(
      buildAdminNotificationsBody({
        sectionName: 's',
        adminNotificationsEnabled: false,
        perClientDefaultMode: 'ENFORCE',
        perClientLoginPageMode: INHERIT,
        perClientOAuth2AuthorizeMode: INHERIT,
        perClientOIEAppIntentMode: INHERIT,
      }),
    ).toEqual({ notificationsEnabled: false })
  })
})

describe('stripReadOnly', () => {
  it('drops _links but keeps other fields', () => {
    expect(stripReadOnly({ defaultMode: 'ENFORCE', _links: { self: {} } })).toEqual({ defaultMode: 'ENFORCE' })
  })
})

describe('toBoolean / toNumber', () => {
  it('coerces booleans and numbers from strings', () => {
    expect(toBoolean('false', true)).toBe(false)
    expect(toBoolean(undefined, true)).toBe(true)
    expect(toNumber('42')).toBe(42)
    expect(toNumber('nope')).toBeUndefined()
  })
})

// Type-only reference so the rollback data shape stays in sync with deploy.
const _rollbackDataType: RateLimitRollbackData | null = null
void _rollbackDataType
