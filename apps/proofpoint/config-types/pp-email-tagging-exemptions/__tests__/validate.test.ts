import validate, { extractExemptionSpecs, senderKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'proofpoint',
    customerId: 'cust-1',
    configTypeId: 'pp-email-tagging-exemptions',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'proofpoint',
      entityType: 'pp-email-tagging-exemptions',
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

describe('Proofpoint Email Tagging Exemptions Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a well-formed exempt sender', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { sender: 'ceo@partner.com' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing sender', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('warns on a sender that does not look like an email address', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { sender: 'not-an-email' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'sender_format')).toBe(true)
  })

  it('rejects the same sender declared twice (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { sender: 'bob@acme.com' } },
        { name: 'b', fields: { sender: 'Bob@Acme.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_sender')).toBe(true)
  })

  it('extractExemptionSpecs trims the sender field', () => {
    const specs = extractExemptionSpecs(makeCtx([{ name: 'a', fields: { sender: '  bob@acme.com  ' } }]).canvas)
    expect(specs[0].sender).toBe('bob@acme.com')
    expect(senderKey(' Bob@Acme.com ')).toBe('bob@acme.com')
  })
})
