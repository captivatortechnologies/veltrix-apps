import validate, { extractGroupSpecs, isDefaultGroup, DEFAULT_GROUP_NAME } from '../validate'
import { resolveSiteId } from '../deploy'
import { buildS1Client } from '../../../lib/s1'
import type { CredentialRef, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sentinelone',
    customerId: 'cust-1',
    configTypeId: 's1-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sentinelone',
      entityType: 's1-groups',
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

/** Build a real client at a given scope to exercise site-id resolution. */
function makeClient(scope: string, scopeId: string | null) {
  const credential = { apiToken: 'token' } as unknown as CredentialRef
  const built = buildS1Client('acme.sentinelone.net', credential, { scope, scope_id: scopeId })
  if ('error' in built) throw new Error(built.error)
  return built.client
}

describe('SentinelOne Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid group', async () => {
    const result = await validate(makeCtx([{ name: 'Group', fields: { name: 'Servers', description: 'prod hosts' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { description: 'no name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate group name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Servers' } },
        { name: 'b', fields: { name: 'Servers' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('warns when the reserved Default Group name is declared', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: DEFAULT_GROUP_NAME } }]))
    // A warning, not a hard error — the canvas is still structurally valid.
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'protected_group')).toBe(true)
  })

  it('extractGroupSpecs defaults inherits to true and trims the name', () => {
    const specs = extractGroupSpecs(makeCtx([{ name: 'g', fields: { name: '  Servers  ' } }]).canvas)
    expect(specs[0].name).toBe('Servers')
    expect(specs[0].inherits).toBe(true)
  })

  it('extractGroupSpecs reads inherits=false from a string or boolean', () => {
    const asString = extractGroupSpecs(makeCtx([{ name: 'g', fields: { name: 'A', inherits: 'false' } }]).canvas)
    const asBool = extractGroupSpecs(makeCtx([{ name: 'g', fields: { name: 'B', inherits: false } }]).canvas)
    expect(asString[0].inherits).toBe(false)
    expect(asBool[0].inherits).toBe(false)
  })

  it('isDefaultGroup detects the default by reserved name or the API flag', () => {
    expect(isDefaultGroup({ name: DEFAULT_GROUP_NAME })).toBe(true)
    expect(isDefaultGroup({ name: 'Other', isDefault: true })).toBe(true)
    expect(isDefaultGroup({ name: 'Servers' })).toBe(false)
  })

  it('resolveSiteId returns siteIds[0] under the site scope', () => {
    const res = resolveSiteId(makeClient('site', 'site-123'))
    expect(res.error).toBeNull()
    expect(res.siteId).toBe('site-123')
  })

  it('resolveSiteId refuses a non-site scope', () => {
    const res = resolveSiteId(makeClient('account', 'acct-1'))
    expect(res.siteId).toBeNull()
    expect(res.error).toContain('site')
  })
})
