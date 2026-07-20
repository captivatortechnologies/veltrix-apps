import validate, { extractBindingSpecs, splitList } from '../validate'
import {
  bindingMemberMatches,
  bindingMemberRef,
  bindingMembersPath,
  bindingPath,
  reconcileBindingMembers,
  type BindingRollbackEntry,
} from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import type { LiveBindingMember } from '../validate'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'resource-set-bindings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'resource-set-bindings',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'okta-identity',
    entityType: 'resource-set-bindings',
    items: sections,
    sections,
    snapshot: {},
  }
}

function validFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceSet: 'iamoJDFKaJxGIr0oamd9g',
    role: 'cr0Yq6IJxGIr0ouum0g3',
    members: [
      'https://acme.okta.com/api/v1/groups/00g1a2b3c4',
      'https://acme.okta.com/api/v1/users/00u5d6e7f8',
    ],
    ...over,
  }
}

describe('Okta Resource Set Bindings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully valid binding with no warnings', async () => {
    const result = await validate(makeCtx([{ name: 'Binding', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('validates a binding to a standard role type', async () => {
    const result = await validate(makeCtx([{ name: 'Binding', fields: validFields({ role: 'HELP_DESK_ADMIN' }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects a missing resource set', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ resourceSet: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('resourceSet'))).toBe(true)
  })

  it('rejects a missing role', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ role: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('role'))).toBe(true)
  })

  it('rejects a binding with no members', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ members: [] }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('members'))).toBe(true)
  })

  it('warns (does not reject) on a suspicious member reference', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ members: ['not-a-member'] }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'suspicious_member')).toBe(true)
  })

  it('warns when the role looks like a display label (contains spaces)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ role: 'Help Desk Role' }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'role_looks_like_label')).toBe(true)
  })

  it('rejects a duplicate (resourceSet, role) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_binding')).toBe(true)
  })

  it('allows the same role bound in different resource sets', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ resourceSet: 'iamA' }) },
        { name: 'sec2', fields: validFields({ resourceSet: 'iamB' }) },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractBindingSpecs', () => {
  it('trims fields and de-dupes members', () => {
    const specs = extractBindingSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            resourceSet: '  iam1  ',
            role: '  cr01  ',
            members: [
              'https://a.okta.com/api/v1/users/00u1',
              'https://a.okta.com/api/v1/users/00u1',
              ' https://a.okta.com/api/v1/groups/00g1 ',
            ],
          },
        },
      ]),
    )
    expect(specs[0].resourceSet).toBe('iam1')
    expect(specs[0].role).toBe('cr01')
    expect(specs[0].members).toEqual([
      'https://a.okta.com/api/v1/users/00u1',
      'https://a.okta.com/api/v1/groups/00g1',
    ])
  })
})

describe('splitList', () => {
  it('handles arrays and delimited strings', () => {
    expect(splitList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(splitList('a,b\nc')).toEqual(['a', 'b', 'c'])
    expect(splitList(42)).toEqual([])
  })
})

describe('binding path builders', () => {
  it('URL-encodes dynamic segments (labels may contain spaces)', () => {
    expect(bindingPath('West Region', 'Help Desk')).toBe(
      '/iam/resource-sets/West%20Region/bindings/Help%20Desk',
    )
    expect(bindingMembersPath('iam1', 'cr01')).toBe('/iam/resource-sets/iam1/bindings/cr01/members')
  })
})

describe('bindingMemberRef / bindingMemberMatches', () => {
  const ornMember: LiveBindingMember = { id: 'irb1', orn: 'orn:okta:directory:1:users:00u1' }
  const urlMember: LiveBindingMember = {
    id: 'irb2',
    _links: { self: { href: 'https://acme.okta.com/api/v1/groups/00g1' } },
  }

  it('prefers the ORN, falling back to the principal REST URL', () => {
    expect(bindingMemberRef(ornMember)).toBe('orn:okta:directory:1:users:00u1')
    expect(bindingMemberRef(urlMember)).toBe('https://acme.okta.com/api/v1/groups/00g1')
    expect(bindingMemberRef({ id: 'x' })).toBeUndefined()
  })

  it('matches a desired reference in either ORN or URL form', () => {
    expect(bindingMemberMatches(ornMember, 'orn:okta:directory:1:users:00u1')).toBe(true)
    expect(bindingMemberMatches(urlMember, 'https://acme.okta.com/api/v1/groups/00g1')).toBe(true)
    expect(bindingMemberMatches(urlMember, 'https://acme.okta.com/api/v1/groups/00gOTHER')).toBe(false)
  })
})

describe('reconcileBindingMembers', () => {
  it('PATCHes only missing additions (before) and DELETEs only undesired members', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const client = {
      request: async (method: string, path: string, opts?: { body?: unknown }) => {
        calls.push({ method, path, body: opts?.body })
        return { status: 200, ok: true, body: '{}', nextUrl: null }
      },
    }
    const current: LiveBindingMember[] = [
      { id: 'keepMe', _links: { self: { href: 'https://a.okta.com/api/v1/groups/00g1' } } }, // desired → kept
      { id: 'dropMe', _links: { self: { href: 'https://a.okta.com/api/v1/groups/00gOLD' } } }, // not desired → deleted
    ]
    // desired keeps 00g1, adds a user, drops 00gOLD
    await reconcileBindingMembers(
      client as never,
      'iam1',
      'cr01',
      ['https://a.okta.com/api/v1/groups/00g1', 'https://a.okta.com/api/v1/users/00u1'],
      current,
    )

    // additions must be PATCHed before any DELETE (never drop to zero members)
    const patchIndex = calls.findIndex((c) => c.method === 'PATCH')
    const deleteIndex = calls.findIndex((c) => c.method === 'DELETE')
    expect(patchIndex).toBeGreaterThan(-1)
    expect(deleteIndex).toBeGreaterThan(patchIndex)

    const patch = calls[patchIndex]
    expect(patch.body).toEqual({ additions: ['https://a.okta.com/api/v1/users/00u1'] })
    expect(calls[deleteIndex].path).toBe('/iam/resource-sets/iam1/bindings/cr01/members/dropMe')
  })

  it('makes no calls when the desired set already matches live', async () => {
    const calls: string[] = []
    const client = {
      request: async (method: string) => {
        calls.push(method)
        return { status: 200, ok: true, body: '{}', nextUrl: null }
      },
    }
    const current: LiveBindingMember[] = [
      { id: 'm1', _links: { self: { href: 'https://a.okta.com/api/v1/users/00u1' } } },
    ]
    await reconcileBindingMembers(client as never, 'iam1', 'cr01', ['https://a.okta.com/api/v1/users/00u1'], current)
    expect(calls).toHaveLength(0)
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: BindingRollbackEntry | null = null
void _rollbackEntryType
