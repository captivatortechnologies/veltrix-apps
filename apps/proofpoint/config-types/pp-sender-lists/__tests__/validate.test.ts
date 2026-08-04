import validate, {
  extractSenderSpecs,
  senderKey,
  isValidEntry,
  readSenderList,
  scopeKey,
  scopeLabel,
  senderListsPath,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import { PPClient } from '../../../lib/proofpoint'

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

  it('validates a safe email entry (defaults to org scope)', async () => {
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

  it('rejects the same sender declared twice in the same (org) scope', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { sender: 'x@y.com', list_type: 'safe' } },
        { name: 'b', fields: { sender: 'X@Y.com', list_type: 'blocked' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_sender')).toBe(true)
  })

  it('allows the same sender declared once per distinct scope', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { sender: 'x@y.com', list_type: 'safe', scope: 'org' } },
        { name: 'b', fields: { sender: 'x@y.com', list_type: 'safe', scope: 'user', scope_id: 'bob@acme.com' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an unsupported scope', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { sender: 'a@b.com', scope: 'tenant' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_scope')).toBe(true)
  })

  it('rejects a user scope without a scope_id', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { sender: 'a@b.com', scope: 'user' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'scope_id_required')).toBe(true)
  })

  it('rejects a group scope without a scope_id', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { sender: 'a@b.com', scope: 'group' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'scope_id_required')).toBe(true)
  })

  it('warns when a user scope_id does not look like an email', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { sender: 'a@b.com', scope: 'user', scope_id: 'not-an-email' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'scope_id_format')).toBe(true)
  })

  it('accepts a group scope with a free-text scope_id', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { sender: 'a@b.com', scope: 'group', scope_id: 'Finance Team' } }]))
    expect(result.valid).toBe(true)
  })

  it('extractSenderSpecs trims and defaults list_type/scope', () => {
    const specs = extractSenderSpecs(makeCtx([{ name: 's', fields: { sender: '  a@b.com  ' } }]).canvas)
    expect(specs[0].sender).toBe('a@b.com')
    expect(specs[0].listType).toBe('safe')
    expect(specs[0].scope).toBe('org')
    expect(specs[0].scopeId).toBe('')
    expect(senderKey('A@B.com')).toBe('a@b.com')
  })

  it('extractSenderSpecs reads a declared user scope + scope_id', () => {
    const specs = extractSenderSpecs(
      makeCtx([{ name: 's', fields: { sender: 'a@b.com', scope: 'user', scope_id: ' Bob@Acme.com ' } }]).canvas,
    )
    expect(specs[0].scope).toBe('user')
    expect(specs[0].scopeId).toBe('Bob@Acme.com')
  })

  it('isValidEntry accepts email/domain/IP/CIDR and rejects junk', () => {
    expect(isValidEntry('a@b.com')).toBe(true)
    expect(isValidEntry('b.com')).toBe(true)
    expect(isValidEntry('*@b.com')).toBe(true)
    expect(isValidEntry('10.0.0.0/24')).toBe(true)
    expect(isValidEntry('192.168.1.*')).toBe(true)
    expect(isValidEntry('nonsense')).toBe(false)
  })

  it('readSenderList reads the allow_list / block_list fields off a sender-lists record', () => {
    const list = { allow_list: ['a@b.com', ' c@d.com '], block_list: ['x@y.com'] }
    expect(readSenderList(list, 'safe')).toEqual(['a@b.com', 'c@d.com'])
    expect(readSenderList(list, 'blocked')).toEqual(['x@y.com'])
    expect(readSenderList({}, 'safe')).toEqual([])
  })

  it('scopeKey normalizes org scope and lower-cases user/group scope ids', () => {
    expect(scopeKey('org', '')).toBe('org')
    expect(scopeKey('user', 'Bob@Acme.com')).toBe('user:bob@acme.com')
    expect(scopeKey('group', 'Finance Team')).toBe('group:finance team')
    expect(scopeKey('bogus', 'x')).toBe('org')
  })

  it('scopeLabel describes each scope for messages/diffs', () => {
    expect(scopeLabel('org', '')).toBe('organization')
    expect(scopeLabel('user', 'bob@acme.com')).toBe('user "bob@acme.com"')
    expect(scopeLabel('group', 'Finance')).toBe('group "Finance"')
  })

  it('senderListsPath builds the org / user / group sender-lists resource path', () => {
    const client = new PPClient({ baseUrl: 'https://us1.proofpointessentials.com/api/v1', auth: { user: 'a', password: 'b' }, org: 'acme.com', timeoutMs: 1000 })
    expect(senderListsPath(client, 'org', '')).toBe('/orgs/acme.com/sender-lists')
    expect(senderListsPath(client, 'user', 'bob@acme.com')).toBe('/orgs/acme.com/users/bob%40acme.com/sender-lists')
    expect(senderListsPath(client, 'group', 'Finance Team')).toBe('/orgs/acme.com/groups/Finance%20Team/sender-lists')
  })
})
