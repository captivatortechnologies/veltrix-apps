import validate, { extractUserSpecs, toPermissions } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'users',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
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

const VALID = { username: 'alice@example.com', name: 'Alice', permissions: '64', password: 'S3cret!' }

describe('Tenable Users Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid user (create, with password)', async () => {
    const result = await validate(makeCtx([{ name: 'User', fields: { ...VALID } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid user without a password (update — password optional)', async () => {
    const result = await validate(
      makeCtx([{ name: 'User', fields: { username: 'bob@example.com', name: 'Bob', permissions: '16' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing username', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Alice', permissions: '16' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('username'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'alice@example.com', permissions: '16' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a username that is not an email', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'not-an-email', name: 'Alice', permissions: '16' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_email')).toBe(true)
  })

  it('rejects a permissions value not in the accepted set', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'alice@example.com', name: 'Alice', permissions: '99' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_permissions')).toBe(true)
  })

  it('accepts each valid permissions level (16/32/40/64)', async () => {
    for (const level of ['16', '32', '40', '64']) {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { username: 'a@b.com', name: 'A', permissions: level } }]),
      )
      expect(result.valid).toBe(true)
    }
  })

  it('rejects a duplicate username (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { username: 'alice@example.com', name: 'Alice', permissions: '16' } },
        { name: 'sec2', fields: { username: 'ALICE@example.com', name: 'Alice 2', permissions: '64' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_user')).toBe(true)
  })

  it('allows two distinct usernames', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { username: 'alice@example.com', name: 'Alice', permissions: '16' } },
        { name: 'sec2', fields: { username: 'bob@example.com', name: 'Bob', permissions: '64' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractUserSpecs', () => {
  it('trims fields, coerces permissions, and drops a blank password', () => {
    const specs = extractUserSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'users',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            username: '  alice@example.com  ',
            name: '  Alice  ',
            permissions: '40',
            password: '   ',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].username).toBe('alice@example.com')
    expect(specs[0].name).toBe('Alice')
    expect(specs[0].permissions).toBe(40)
    expect(specs[0].password).toBeUndefined()
    // enabled defaults to true when the checkbox is unset
    expect(specs[0].enabled).toBe(true)
  })

  it('preserves a password that contains spaces', () => {
    const specs = extractUserSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'users',
      items: [],
      sections: [{ name: 'sec1', fields: { username: 'a@b.com', name: 'A', password: 'pa ss' } }],
      snapshot: {},
    })
    expect(specs[0].password).toBe('pa ss')
  })

  it('reads enabled=false from the checkbox', () => {
    const specs = extractUserSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'users',
      items: [],
      sections: [{ name: 'sec1', fields: { username: 'a@b.com', name: 'A', enabled: false } }],
      snapshot: {},
    })
    expect(specs[0].enabled).toBe(false)
  })
})

describe('toPermissions', () => {
  it('defaults an empty value to 16 (Basic)', () => {
    expect(toPermissions('')).toBe(16)
    expect(toPermissions(undefined)).toBe(16)
  })
  it('coerces a numeric string', () => {
    expect(toPermissions('64')).toBe(64)
  })
  it('passes a number through', () => {
    expect(toPermissions(40)).toBe(40)
  })
})
