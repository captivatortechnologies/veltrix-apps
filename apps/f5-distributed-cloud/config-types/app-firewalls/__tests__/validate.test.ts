import validate, { extractAppFirewallSpecs } from '../validate'
import { buildAppFirewallSpecBody, stripMetadata } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'f5-distributed-cloud',
    customerId: 'cust-1',
    configTypeId: 'app-firewalls',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'f5-distributed-cloud',
      entityType: 'app-firewalls',
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
    toolType: 'f5-distributed-cloud',
    entityType: 'app-firewalls',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('F5 XC App Firewall Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal App Firewall (name only, defaults apply)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'default-waf' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'default-waf' } },
        { name: 'sec2', fields: { name: 'default-waf' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('requires at least one allowed response code when restricting codes', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'strict-waf', responseCodesMode: 'allowed_response_codes' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('allowedResponseCodes'))).toBe(true)
  })

  it('accepts a restricted response code list when codes are provided', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'strict-waf', responseCodesMode: 'allowed_response_codes', allowedResponseCodes: ['200', '404'] },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('requires custom HTML when using a custom blocking page', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'custom-page-waf', blockingPageMode: 'blocking_page' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('customBlockingPageHtml'))).toBe(true)
  })
})

describe('extractAppFirewallSpecs', () => {
  it('defaults enforcementMode/detectionMode/bot protection/response codes/blocking page', () => {
    const specs = extractAppFirewallSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'waf1' } }]))
    expect(specs[0].enforcementMode).toBe('blocking')
    expect(specs[0].enableBotProtection).toBe(true)
    expect(specs[0].responseCodesMode).toBe('allow_all_response_codes')
    expect(specs[0].blockingPageMode).toBe('use_default_blocking_page')
  })

  it('parses allowedResponseCodes to integers', () => {
    const specs = extractAppFirewallSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'waf1', allowedResponseCodes: ['200', '404', 'not-a-number'] } }]),
    )
    expect(specs[0].allowedResponseCodes).toEqual([200, 404])
  })
})

describe('buildAppFirewallSpecBody', () => {
  it('builds a default policy body', () => {
    const specs = extractAppFirewallSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'waf1' } }]))
    const body = buildAppFirewallSpecBody(specs[0])
    expect(body.allow_all_response_codes).toBe(true)
    expect(body.use_default_blocking_page).toBe(true)
    expect(body.blocking).toBe(true)
    expect(body.default_bot_setting).toBe(true)
    expect(body.default_detection_settings).toBe(true)
  })

  it('builds a restricted response codes + custom blocking page body', () => {
    const specs = extractAppFirewallSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: 'waf1',
            enforcementMode: 'monitoring',
            responseCodesMode: 'allowed_response_codes',
            allowedResponseCodes: ['200', '404'],
            blockingPageMode: 'blocking_page',
            customBlockingPageHtml: '<h1>Blocked</h1>',
            customBlockingResponseCode: '403',
          },
        },
      ]),
    )
    const body = buildAppFirewallSpecBody(specs[0])
    expect(body.monitoring).toBe(true)
    expect(body.allow_all_response_codes).toBeUndefined()
    expect(body.allowed_response_codes).toEqual({ response_code: [200, 404] })
    expect(body.use_default_blocking_page).toBeUndefined()
    expect(body.blocking_page).toEqual({ blocking_page: '<h1>Blocked</h1>', response_code: '403' })
  })
})

describe('stripMetadata', () => {
  it('keeps only name/description/disable/labels/annotations', () => {
    const stripped = stripMetadata({ name: 'waf1', description: 'desc', disable: false, uid: 'abc' })
    expect(stripped).toEqual({ name: 'waf1', description: 'desc', disable: false, labels: undefined, annotations: undefined })
  })
})
