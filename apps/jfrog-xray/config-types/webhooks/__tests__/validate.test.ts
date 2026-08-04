import validate from '../validate'
import { buildWebhookBody, extractWebhookSpecs, webhookKey } from '../_shared'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'jfrog-xray',
    customerId: 'cust-1',
    configTypeId: 'webhooks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jfrog-xray',
      entityType: 'webhooks',
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

function item(name: string, fields: Record<string, unknown>): CanvasItemSnapshot {
  return { name, fields: { name, url: 'https://example.com/hook', ...fields } }
}

describe('JFrog Xray Webhooks — validate', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed webhook', async () => {
    const result = await validate(makeCtx([item('my-webhook', {})]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a name', async () => {
    const result = await validate(makeCtx([{ name: 'x', fields: { url: 'https://example.com' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NAME')).toBe(true)
  })

  it('rejects a name containing a slash', async () => {
    const result = await validate(makeCtx([item('bad/name', {})]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_NAME')).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(makeCtx([item('dup', {}), item('dup', {})]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('requires a URL', async () => {
    const result = await validate(makeCtx([{ name: 'x', fields: { name: 'x', url: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_URL')).toBe(true)
  })

  it('rejects a malformed URL', async () => {
    const result = await validate(makeCtx([item('x', { url: 'not a url' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_URL')).toBe(true)
  })

  it('rejects a non-http(s) URL scheme', async () => {
    const result = await validate(makeCtx([item('x', { url: 'ftp://example.com/hook' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_URL')).toBe(true)
  })

  it('warns on a username without a password', async () => {
    const result = await validate(makeCtx([item('x', { user_name: 'svc' })]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'INCOMPLETE_AUTH')).toBe(true)
  })

  it('warns on a password without a username', async () => {
    const result = await validate(makeCtx([item('x', { password: 'secret' })]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'INCOMPLETE_AUTH')).toBe(true)
  })
})

describe('JFrog Xray Webhooks — _shared helpers', () => {
  it('extractWebhookSpecs reads and trims canvas fields, including keyvalue headers', () => {
    const specs = extractWebhookSpecs(
      makeCtx([{ name: 'e', fields: { name: '  my-webhook  ', url: 'https://example.com/hook', headers: { 'X-Token': 'abc' } } }]).canvas,
    )
    expect(specs[0].name).toBe('my-webhook')
    expect(specs[0].headers).toEqual({ 'X-Token': 'abc' })
  })

  it('webhookKey trims but preserves case', () => {
    expect(webhookKey('  My-Webhook  ')).toBe('My-Webhook')
  })

  it('buildWebhookBody produces the full create/update payload shape', () => {
    const specs = extractWebhookSpecs(
      makeCtx([item('my-webhook', { description: 'Slack relay', user_name: 'svc', password: 'secret', use_proxy: true, headers: { 'X-Token': 'abc' } })]).canvas,
    )
    const body = buildWebhookBody(specs[0])
    expect(body).toEqual({
      name: 'my-webhook',
      url: 'https://example.com/hook',
      use_proxy: true,
      description: 'Slack relay',
      user_name: 'svc',
      password: 'secret',
      headers: { 'X-Token': 'abc' },
    })
  })

  it('buildWebhookBody omits password/headers/user_name when unset', () => {
    const specs = extractWebhookSpecs(makeCtx([item('bare', {})]).canvas)
    const body = buildWebhookBody(specs[0])
    expect(body.password).toBeUndefined()
    expect(body.user_name).toBeUndefined()
    expect(body.headers).toBeUndefined()
  })
})
