import validate, { extractResourceSetSpecs, splitList } from '../validate'
import {
  findResourceSetByLabel,
  membershipMatches,
  membershipRef,
  reconcileResources,
  type ResourceSetRollbackEntry,
} from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import type { LiveResourceMembership, LiveResourceSet } from '../validate'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'resource-sets',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'resource-sets',
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
    entityType: 'resource-sets',
    items: sections,
    sections,
    snapshot: {},
  }
}

function validFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: 'West Region Groups',
    description: 'Groups for the west region helpdesk',
    resources: ['orn:okta:directory:00o1a2b3c4:groups', 'https://acme.okta.com/api/v1/users'],
    ...over,
  }
}

describe('Okta Resource Sets Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully valid resource set with no warnings', async () => {
    const result = await validate(makeCtx([{ name: 'Set', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects a missing label', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ label: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('label'))).toBe(true)
  })

  it('rejects a missing description', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ description: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('description'))).toBe(true)
  })

  it('rejects a set with no resources', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ resources: [] }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('resources'))).toBe(true)
  })

  it('warns (does not reject) on a suspicious resource reference', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ resources: ['not-a-resource'] }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'suspicious_resource')).toBe(true)
  })

  it('rejects a duplicate label (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ label: 'Region' }) },
        { name: 'sec2', fields: validFields({ label: 'region' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_label')).toBe(true)
  })
})

describe('extractResourceSetSpecs', () => {
  it('trims fields and de-dupes resources', () => {
    const specs = extractResourceSetSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            label: '  Region  ',
            description: '  Scope  ',
            resources: ['orn:okta:x:1:groups', 'orn:okta:x:1:groups', ' https://a.okta.com/api/v1/users '],
          },
        },
      ]),
    )
    expect(specs[0].label).toBe('Region')
    expect(specs[0].resources).toEqual(['orn:okta:x:1:groups', 'https://a.okta.com/api/v1/users'])
  })
})

describe('splitList', () => {
  it('handles arrays and delimited strings', () => {
    expect(splitList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(splitList('a,b\nc')).toEqual(['a', 'b', 'c'])
    expect(splitList(42)).toEqual([])
  })
})

describe('findResourceSetByLabel', () => {
  it('matches an exact label and returns null otherwise', () => {
    const sets: LiveResourceSet[] = [
      { id: 'iam1', label: 'Region' },
      { id: 'iam2', label: 'West Region Groups' },
    ]
    expect(findResourceSetByLabel(sets, 'West Region Groups')?.id).toBe('iam2')
    expect(findResourceSetByLabel(sets, 'Nope')).toBe(null)
  })
})

describe('membershipRef / membershipMatches', () => {
  const ornMembership: LiveResourceMembership = { id: 'ire1', orn: 'orn:okta:directory:1:groups' }
  const urlMembership: LiveResourceMembership = {
    id: 'ire2',
    _links: { self: { href: 'https://acme.okta.com/api/v1/users' } },
  }

  it('prefers the ORN, falling back to the REST URL', () => {
    expect(membershipRef(ornMembership)).toBe('orn:okta:directory:1:groups')
    expect(membershipRef(urlMembership)).toBe('https://acme.okta.com/api/v1/users')
    expect(membershipRef({ id: 'x' })).toBeUndefined()
  })

  it('matches a desired reference in either ORN or URL form', () => {
    expect(membershipMatches(ornMembership, 'orn:okta:directory:1:groups')).toBe(true)
    expect(membershipMatches(urlMembership, 'https://acme.okta.com/api/v1/users')).toBe(true)
    expect(membershipMatches(ornMembership, 'orn:okta:directory:1:apps')).toBe(false)
  })
})

describe('reconcileResources', () => {
  it('PATCHes only missing additions and DELETEs only undesired memberships', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const client = {
      request: async (method: string, path: string, opts?: { body?: unknown }) => {
        calls.push({ method, path, body: opts?.body })
        return { status: 200, ok: true, body: '{}', nextUrl: null }
      },
    }
    const current: LiveResourceMembership[] = [
      { id: 'keepMe', orn: 'orn:okta:x:1:groups' }, // desired → kept
      { id: 'dropMe', orn: 'orn:okta:x:1:apps' }, // not desired → deleted
    ]
    // desired keeps groups, adds users, drops apps
    await reconcileResources(
      client as never,
      'setId',
      ['orn:okta:x:1:groups', 'https://a.okta.com/api/v1/users'],
      current,
    )

    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.body).toEqual({ additions: ['https://a.okta.com/api/v1/users'] })
    const deletes = calls.filter((c) => c.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].path).toBe('/iam/resource-sets/setId/resources/dropMe')
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: ResourceSetRollbackEntry | null = null
void _rollbackEntryType
