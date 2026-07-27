import validate, { extractUserSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'users',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
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

function validUserFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: 'jane.doe@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    ...overrides,
  }
}

describe('CrowdStrike Users Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid user configuration', async () => {
    const result = await validate(makeCtx([{ name: 'User', fields: validUserFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing email', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validUserFields({ email: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a malformed email', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validUserFields({ email: 'not-an-email' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects duplicate users across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validUserFields() },
        { name: 'sec2', fields: validUserFields({ firstName: 'Janet' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_email')).toBe(true)
  })

  it('treats email as case-insensitive for uniqueness', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validUserFields({ email: 'jane.doe@example.com' }) },
        { name: 'sec2', fields: validUserFields({ email: 'Jane.Doe@Example.com' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_email')).toBe(true)
  })

  it('accepts a user with no roles (roles optional)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validUserFields({ roleIds: '' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('accepts a user with declared roles', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validUserFields({ roleIds: 'falconhost_role_admin, falconhost_role_analyst' }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns when a user has no name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validUserFields({ firstName: '', lastName: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_name')).toBe(true)
  })
})

describe('extractUserSpecs', () => {
  it('lowercases the email and trims name fields', () => {
    const specs = extractUserSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'users',
      items: [],
      sections: [
        { name: 'sec1', fields: { email: '  Jane.Doe@Example.COM ', firstName: ' Jane ', lastName: ' Doe ' } },
      ],
      snapshot: {},
    })
    expect(specs[0].email).toBe('jane.doe@example.com')
    expect(specs[0].firstName).toBe('Jane')
    expect(specs[0].lastName).toBe('Doe')
  })

  it('parses roleIds into a list and sets manageRoles', () => {
    const specs = extractUserSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'users',
      items: [],
      sections: [
        { name: 'withRoles', fields: { email: 'a@example.com', roleIds: 'r1, r2' } },
        { name: 'noRoles', fields: { email: 'b@example.com' } },
      ],
      snapshot: {},
    })
    expect(specs[0].roleIds).toHaveLength(2)
    expect(specs[0].roleIds).toContain('r1')
    expect(specs[0].manageRoles).toBe(true)
    expect(specs[1].roleIds).toHaveLength(0)
    expect(specs[1].manageRoles).toBe(false)
  })

  it('leaves optional name fields undefined when blank', () => {
    const specs = extractUserSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'users',
      items: [],
      sections: [{ name: 'sec1', fields: { email: 'a@example.com', firstName: '  ' } }],
      snapshot: {},
    })
    expect(specs[0].firstName).toBeUndefined()
    expect(specs[0].lastName).toBeUndefined()
  })
})
