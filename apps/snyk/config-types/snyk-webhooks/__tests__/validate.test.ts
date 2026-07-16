import validate, { checkHttpsUrl, extractWebhookSpecs, webhookKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-webhooks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-webhooks',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { org_id: 'org-123' },
    platform: stubPlatform,
  }
}

describe('Snyk Webhooks Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid webhook', async () => {
    const result = await validate(makeCtx([{ name: 'W', fields: { url: 'https://example.com/hook', secret: 's3cret' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a non-https url', async () => {
    const result = await validate(makeCtx([{ name: 'W', fields: { url: 'http://example.com/hook', secret: 's' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_url')).toBe(true)
  })

  it('requires a signing secret', async () => {
    const result = await validate(makeCtx([{ name: 'W', fields: { url: 'https://example.com/hook' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('secret'))).toBe(true)
  })

  it('rejects duplicate urls case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { url: 'https://example.com/hook', secret: 's' } },
        { name: 'b', fields: { url: 'https://EXAMPLE.com/hook', secret: 's' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_webhook')).toBe(true)
  })

  it('helpers behave', () => {
    expect(checkHttpsUrl('https://x.io')).toBeNull()
    expect(checkHttpsUrl('ftp://x.io')).toContain('https')
    expect(checkHttpsUrl('not a url')).toContain('valid')
    expect(webhookKey('https://X.io/A')).toBe('https://x.io/a')
    expect(extractWebhookSpecs(makeCtx([{ name: 'w', fields: { url: '  https://x.io  ' } }]).canvas)[0].url).toBe('https://x.io')
  })
})
