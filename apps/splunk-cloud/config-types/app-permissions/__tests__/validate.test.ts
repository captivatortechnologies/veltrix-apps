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
    configTypeId: 'app-permissions',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-cloud',
      entityType: 'app-permissions',
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

describe('Splunk Cloud App Permissions Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid app-permission entry', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { appName: 'my_app', readRoles: ['user', 'power'], writeRoles: ['admin'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing app name', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { readRoles: ['admin'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid app name format', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { appName: '1bad name', readRoles: ['admin'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects an entry with no read or write roles', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { appName: 'my_app' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_perms')).toBe(true)
  })

  it('rejects duplicate app entries', async () => {
    const result = await validate(
      makeCtx([
        { name: 'p1', fields: { appName: 'my_app', readRoles: ['user'] } },
        { name: 'p2', fields: { appName: 'my_app', writeRoles: ['admin'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_app')).toBe(true)
  })

  it('rejects an invalid Splunk role name', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { appName: 'my_app', readRoles: ['Bad Role'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_role')).toBe(true)
  })

  it('accepts the "*" all-roles wildcard for read', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { appName: 'my_app', readRoles: ['*'] } }]))
    expect(result.valid).toBe(true)
  })

  it('warns (does not block) on granting write to the broad "user" role', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { appName: 'my_app', writeRoles: ['user'] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'broad_write')).toBe(true)
  })

  it('warns on duplicate roles within a list', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { appName: 'my_app', readRoles: ['user', 'user'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'duplicate_role')).toBe(true)
  })

  it('accepts read roles as a comma-separated string', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { appName: 'my_app', readRoles: 'user, power, admin' } }]),
    )
    expect(result.valid).toBe(true)
  })
})
