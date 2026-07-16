import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'users',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Users Canvas',
      toolType: 'splunk-cloud',
      entityType: 'users',
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

describe('Splunk Cloud Users Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully specified user', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            username: 'ada.lovelace',
            roles: ['user', 'power'],
            realname: 'Ada Lovelace',
            email: 'ada@example.com',
            defaultApp: 'search',
            tz: 'Europe/London',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts an email-style username', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'ada@example.com', roles: ['user'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing username', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { roles: ['user'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.username') && e.code === 'required')).toBe(true)
  })

  it('rejects a username with spaces', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'ada lovelace', roles: ['user'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects a username with a colon or slash', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'ada:lovelace', roles: ['user'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects a username exceeding max length', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'a'.repeat(101), roles: ['user'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate usernames across sections (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { username: 'ada', roles: ['user'] } },
        { name: 'sec2', fields: { username: 'ADA', roles: ['power'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a user with no roles field', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'ada' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.roles') && e.code === 'required')).toBe(true)
  })

  it('rejects a user with an empty roles list', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'ada', roles: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.roles') && e.code === 'required')).toBe(true)
  })

  it('rejects an invalid role name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'ada', roles: ['Bad Role'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.roles') && e.code === 'invalid_format')).toBe(true)
  })

  it('warns when assigning the admin role', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'ada', roles: ['admin'] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'privileged_role')).toBe(true)
  })

  it('warns when assigning the sc_admin role', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'ada', roles: ['sc_admin'] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'privileged_role')).toBe(true)
  })

  it('warns on a duplicate role within one user', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'ada', roles: ['user', 'user'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'duplicate_role')).toBe(true)
  })

  it('rejects an invalid email address', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'ada', roles: ['user'], email: 'not-an-email' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.email') && e.code === 'invalid_format')).toBe(true)
  })

  it('accepts a user without an email address', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'ada', roles: ['user'] } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an invalid default app', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'ada', roles: ['user'], defaultApp: 'my app!' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.defaultApp') && e.code === 'invalid_format')).toBe(true)
  })

  it('accepts roles as a comma-separated string', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'ada', roles: 'user, power' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates multiple users', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { username: 'ada', roles: ['user'] } },
        { name: 'sec2', fields: { username: 'grace', roles: ['power'], email: 'grace@example.com' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})
