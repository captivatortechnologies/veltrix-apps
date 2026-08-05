import validate, { extractRecipientSpecs, recipientKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(
  sections: Array<{ name: string; fields: Record<string, unknown> }>,
  settings: Record<string, unknown> = {},
): PipelineContext {
  return {
    appId: 'sentinelone',
    customerId: 'cust-1',
    configTypeId: 's1-notification-recipients',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sentinelone',
      entityType: 's1-notification-recipients',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings,
    platform: stubPlatform,
  }
}

describe('SentinelOne Notification Recipients Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid recipient', async () => {
    const result = await validate(makeCtx([{ name: 'Recipient', fields: { email: 'soc@acme.com', name: 'SOC Team' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing email', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Email' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('email'))).toBe(true)
  })

  it('rejects a malformed email', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { email: 'not-an-email' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_email')).toBe(true)
  })

  it('rejects duplicate emails (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { email: 'Soc@Acme.com' } },
        { name: 'b', fields: { email: 'soc@acme.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_recipient')).toBe(true)
  })

  it('rejects the unsupported "group" scope', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { email: 'soc@acme.com' } }], { scope: 'group' }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'unsupported_scope')).toBe(true)
  })

  it('extractRecipientSpecs trims fields', () => {
    const specs = extractRecipientSpecs(makeCtx([{ name: 'r', fields: { email: '  soc@acme.com  ' } }]).canvas)
    expect(specs[0].email).toBe('soc@acme.com')
    expect(recipientKey('  SOC@Acme.com ')).toBe('soc@acme.com')
  })
})
