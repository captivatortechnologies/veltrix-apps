import validate, { extractAdminUserSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-admin-users',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-admin-users',
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

/** A complete, valid admin user item (every required field present). */
function validUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    login_name: 'admin@example.com',
    user_name: 'Alice Admin',
    email: 'admin@example.com',
    role_name: 'Super Admin',
    password: 'S3cret!Pass',
    ...overrides,
  }
}

describe('ZIA Admin Users Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid admin user', async () => {
    const result = await validate(makeCtx([{ name: 'Admin User', fields: validUser() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing login_name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validUser({ login_name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('login_name'))).toBe(true)
  })

  it('rejects a missing role_name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validUser({ role_name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('role_name'))).toBe(true)
  })

  it('rejects a missing password (required on every deploy)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validUser({ password: '   ' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('password'))).toBe(true)
  })

  it('rejects an email without an "@"', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validUser({ email: 'not-an-email' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_email')).toBe(true)
  })

  it('rejects duplicate login names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: validUser({ login_name: 'Admin@Example.com' }) },
        { name: 'b', fields: validUser({ login_name: 'admin@example.com' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_admin_user')).toBe(true)
  })

  it('extractAdminUserSpecs trims fields, drops blank comments and preserves the password', () => {
    const specs = extractAdminUserSpecs(
      makeCtx([
        {
          name: 'Admin User',
          fields: validUser({
            login_name: '  admin@example.com  ',
            comments: '   ',
            disabled: true,
            password: '  keep spaces  ',
          }),
        },
      ]).canvas,
    )
    expect(specs[0].loginName).toBe('admin@example.com')
    expect(specs[0].comments).toBeUndefined()
    expect(specs[0].disabled).toBe(true)
    // Password characters are preserved verbatim (a non-blank value is not trimmed).
    expect(specs[0].password).toBe('  keep spaces  ')
  })
})
