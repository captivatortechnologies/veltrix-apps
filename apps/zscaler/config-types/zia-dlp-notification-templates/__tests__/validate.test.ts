import validate, { extractDlpTemplateSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-dlp-notification-templates',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-dlp-notification-templates',
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

const validFields = {
  name: 'Standard DLP Notice',
  subject: 'DLP violation detected',
  plain_text_message: 'Your transaction was blocked by a DLP policy.',
}

describe('ZIA DLP Notification Templates Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid template', async () => {
    const result = await validate(makeCtx([{ name: 'Template', fields: { ...validFields } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { subject: 'S', plain_text_message: 'M' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing subject', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'T', plain_text_message: 'M' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('subject'))).toBe(true)
  })

  it('rejects a missing plain text message', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'T', subject: 'S' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('plain_text_message'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Notice' } },
        { name: 'b', fields: { ...validFields, name: 'notice' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_dlp_template')).toBe(true)
  })

  it('extractDlpTemplateSpecs trims, drops blank html, and applies boolean defaults', () => {
    const specs = extractDlpTemplateSpecs(
      makeCtx([
        {
          name: 'Template',
          fields: { name: '  Notice  ', subject: '  Hi  ', plain_text_message: '  Body  ', html_message: '   ' },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Notice')
    expect(specs[0].subject).toBe('Hi')
    expect(specs[0].plainTextMessage).toBe('Body')
    expect(specs[0].htmlMessage).toBeUndefined()
    // tls_enabled defaults false; attach_content defaults true.
    expect(specs[0].tlsEnabled).toBe(false)
    expect(specs[0].attachContent).toBe(true)
  })
})
