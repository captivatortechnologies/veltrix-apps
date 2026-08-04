import validate, { extractRoleSpecs, isReservedRole, splitList } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'roles',
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

describe('Elastic Security Roles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal role with cluster privileges', async () => {
    const result = await validate(
      makeCtx([{ name: 'Role', fields: { name: 'secops-analyst', cluster: ['monitor'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a fully-specified role', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Role',
          fields: {
            name: 'secops-full',
            description: 'Full SecOps access',
            cluster: ['monitor', 'manage_ilm'],
            runAs: ['svc-account'],
            indicesJson: '[{"names":["logs-*"],"privileges":["read"]}]',
            applicationsJson: '[{"application":"kibana-.kibana","privileges":["all"],"resources":["*"]}]',
            metadataJson: '{"team":"secops"}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { cluster: ['monitor'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a role granting nothing', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { name: 'empty-role' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_privileges')).toBe(true)
  })

  it('rejects invalid indicesJson', async () => {
    const result = await validate(
      makeCtx([{ name: 'r1', fields: { name: 'bad-indices', indicesJson: 'not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_indices')).toBe(true)
  })

  it('rejects invalid applicationsJson', async () => {
    const result = await validate(
      makeCtx([{ name: 'r1', fields: { name: 'bad-apps', applicationsJson: '{"not":"an array"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_applications')).toBe(true)
  })

  it('warns on reserved metadata keys', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'r1',
          fields: { name: 'has-reserved', cluster: ['monitor'], metadataJson: '{"_reserved":true}' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'reserved_metadata')).toBe(true)
  })

  it('rejects a duplicate role name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'r1', fields: { name: 'dup', cluster: ['monitor'] } },
        { name: 'r2', fields: { name: 'dup', cluster: ['monitor'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_role')).toBe(true)
  })
})

describe('extractRoleSpecs', () => {
  it('trims fields and normalizes list fields', () => {
    const specs = extractRoleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'roles',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: { name: '  secops  ', cluster: [' monitor ', ''], runAs: 'svc1, svc2' },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('secops')
    expect(specs[0].cluster).toEqual(['monitor'])
    expect(specs[0].runAs).toEqual(['svc1', 'svc2'])
  })
})

describe('splitList', () => {
  it('passes an array through, trimming and dropping blanks', () => {
    expect(splitList([' monitor ', '', 'manage_ilm'])).toEqual(['monitor', 'manage_ilm'])
  })
  it('splits a comma/newline-separated string', () => {
    expect(splitList('monitor, manage_ilm\nmanage_security')).toEqual(['monitor', 'manage_ilm', 'manage_security'])
  })
})

describe('isReservedRole', () => {
  it('is true when metadata._reserved is true', () => {
    expect(isReservedRole({ metadata: { _reserved: true } })).toBe(true)
  })
  it('is false otherwise', () => {
    expect(isReservedRole({})).toBe(false)
    expect(isReservedRole({ metadata: {} })).toBe(false)
    expect(isReservedRole({ metadata: { _reserved: false } })).toBe(false)
  })
})
