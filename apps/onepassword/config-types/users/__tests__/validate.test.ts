import validate, { extractUserSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'onepassword',
    customerId: 'cust-1',
    configTypeId: 'users',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'onepassword',
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

describe('1Password Users Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a well-formed user', async () => {
    const result = await validate(makeCtx([{ name: 'User', fields: { userName: 'ada@example.com', givenName: 'Ada' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing userName', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a userName that is not an email address', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { userName: 'not-an-email' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_email')).toBe(true)
  })

  it('rejects a duplicate userName (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { userName: 'ada@example.com' } },
        { name: 'sec2', fields: { userName: 'Ada@Example.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_user')).toBe(true)
  })

  it('allows two distinct users', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { userName: 'ada@example.com' } },
        { name: 'sec2', fields: { userName: 'grace@example.com' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractUserSpecs', () => {
  it('trims fields and defaults active to true', () => {
    const specs = extractUserSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onepassword',
      entityType: 'users',
      items: [],
      sections: [{ name: 'sec1', fields: { userName: '  ada@example.com  ', givenName: ' Ada ' } }],
      snapshot: {},
    })
    expect(specs[0].userName).toBe('ada@example.com')
    expect(specs[0].givenName).toBe('Ada')
    expect(specs[0].active).toBe(true)
  })

  it('treats active: false explicitly as suspended', () => {
    const specs = extractUserSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onepassword',
      entityType: 'users',
      items: [],
      sections: [{ name: 'sec1', fields: { userName: 'ada@example.com', active: false } }],
      snapshot: {},
    })
    expect(specs[0].active).toBe(false)
  })
})
