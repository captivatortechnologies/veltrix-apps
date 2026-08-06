import validate from '../validate'
import { accountEmail, accountId, extractUserAccountSpecs, parseRights, userAccountKey } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'bitdefender-gravityzone',
    customerId: 'cust-1',
    configTypeId: 'user-accounts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'bitdefender-gravityzone',
      entityType: 'user-accounts',
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

const validFields = { email: 'jane@example.com', fullName: 'Jane Doe', role: '1', timezone: 'UTC', language: 'en_US' }

describe('GravityZone User Accounts Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed account', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires email and fullName', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED')).toHaveLength(2)
  })

  it('rejects a malformed email', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { ...validFields, email: 'not-an-email' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_EMAIL')).toBe(true)
  })

  it('rejects an undocumented role', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { ...validFields, role: '4' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_ROLE')).toBe(true)
  })

  it('warns on a duplicate email', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_EMAIL')).toBe(true)
  })

  it('rejects malformed Rights JSON', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { ...validFields, role: '5', rights: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('warns when Rights is set but role is not Custom', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { ...validFields, role: '1', rights: '{"a":1}' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'RIGHTS_IGNORED')).toBe(true)
  })
})

describe('GravityZone User Accounts shared helpers', () => {
  it('userAccountKey trims and lower-cases', () => {
    expect(userAccountKey('  Jane@Example.com  ')).toBe('jane@example.com')
  })

  it('extractUserAccountSpecs reads and trims every field', () => {
    const specs = extractUserAccountSpecs(makeCtx([{ name: 'a', fields: { ...validFields, targetIds: 'a, b ,c' } }]).canvas)
    expect(specs[0].email).toBe('jane@example.com')
    expect(specs[0].role).toBe(1)
    expect(specs[0].targetIds).toEqual(['a', 'b', 'c'])
  })

  it('parseRights parses a valid JSON object', () => {
    const { value, error } = parseRights({ itemName: 'a', email: 'e', fullName: 'f', role: 5, timezone: '', language: '', password: '', targetIds: [], rightsRaw: '{"manageUsers":true}' })
    expect(error).toBeNull()
    expect(value).toEqual({ manageUsers: true })
  })

  it('accountEmail and accountId read defensively', () => {
    expect(accountEmail({ email: 'e@x.com' })).toBe('e@x.com')
    expect(accountId({ id: 'acc-1' })).toBe('acc-1')
    expect(accountId({ accountId: 'acc-2' })).toBe('acc-2')
    expect(accountId({})).toBe('')
  })
})
