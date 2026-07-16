import validate, { extractSenderSpecs, senderKey, isValidEntry, readSenderList } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'proofpoint',
    customerId: 'cust-1',
    configTypeId: 'pp-sender-lists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'proofpoint',
      entityType: 'pp-sender-lists',
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

describe('Proofpoint Sender List Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a safe email entry', async () => {
    const result = await validate(makeCtx([{ name: 'Sender', fields: { sender: 'ceo@partner.com', list_type: 'safe' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a blocked domain entry', async () => {
    const result = await validate(makeCtx([{ name: 'Sender', fields: { sender: '*@spam.example', list_type: 'blocked' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing sender', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { list_type: 'safe' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unsupported list type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { sender: 'a@b.com', list_type: 'graylist' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_list')).toBe(true)
  })

  it('warns on a malformed sender but stays valid', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { sender: 'not a sender', list_type: 'safe' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'sender_format')).toBe(true)
  })

  it('rejects the same sender declared twice', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { sender: 'x@y.com', list_type: 'safe' } },
        { name: 'b', fields: { sender: 'X@Y.com', list_type: 'blocked' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_sender')).toBe(true)
  })

  it('extractSenderSpecs trims and defaults list_type to safe', () => {
    const specs = extractSenderSpecs(makeCtx([{ name: 's', fields: { sender: '  a@b.com  ' } }]).canvas)
    expect(specs[0].sender).toBe('a@b.com')
    expect(specs[0].listType).toBe('safe')
    expect(senderKey('A@B.com')).toBe('a@b.com')
  })

  it('isValidEntry accepts email/domain/IP/CIDR and rejects junk', () => {
    expect(isValidEntry('a@b.com')).toBe(true)
    expect(isValidEntry('b.com')).toBe(true)
    expect(isValidEntry('*@b.com')).toBe(true)
    expect(isValidEntry('10.0.0.0/24')).toBe(true)
    expect(isValidEntry('192.168.1.*')).toBe(true)
    expect(isValidEntry('nonsense')).toBe(false)
  })

  it('readSenderList reads the allow_list / block_list org fields', () => {
    const org = { allow_list: ['a@b.com', ' c@d.com '], block_list: ['x@y.com'] }
    expect(readSenderList(org, 'safe')).toEqual(['a@b.com', 'c@d.com'])
    expect(readSenderList(org, 'blocked')).toEqual(['x@y.com'])
    expect(readSenderList({}, 'safe')).toEqual([])
  })
})
