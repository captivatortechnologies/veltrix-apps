import validate, {
  dedupe,
  extractRoleMappingSpecs,
  partitionRoles,
} from '../validate'
import { collectRoleIds } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const UG = 'ug-11111111'
const CG = 'cg-22222222'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'mssp-role-mappings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'mssp-role-mappings',
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
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'crowdstrike-edr',
    entityType: 'mssp-role-mappings',
    items: [],
    sections,
    snapshot: {},
  }
}

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userGroupId: UG,
    cidGroupId: CG,
    roleIds: 'falcon_console_admin, sensor_update_manager',
    ...overrides,
  }
}

describe('CrowdStrike MSSP Role Mappings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid role mapping configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Mapping', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing user group id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ userGroupId: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'sec1.userGroupId' && e.code === 'required')).toBe(true)
  })

  it('rejects a missing CID group id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ cidGroupId: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'sec1.cidGroupId' && e.code === 'required')).toBe(true)
  })

  it('rejects a mapping with no role ids', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ roleIds: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'sec1.roleIds' && e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate binding per canvas', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields({ roleIds: 'other_role' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_binding')).toBe(true)
  })

  it('allows the same user group bound to a different CID group', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields({ cidGroupId: 'cg-99999999' }) },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractRoleMappingSpecs', () => {
  it('parses the binding and de-duplicated role ids', () => {
    const specs = extractRoleMappingSpecs(
      makeCanvas([{ name: 'sec1', fields: validFields({ roleIds: 'r1, r2, r1' }) }]),
    )
    expect(specs).toHaveLength(1)
    expect(specs[0].userGroupId).toBe(UG)
    expect(specs[0].cidGroupId).toBe(CG)
    expect(specs[0].roleIds).toEqual(['r1', 'r2'])
  })
})

describe('partitionRoles', () => {
  it('grants the missing role and revokes the extra (additive-grant convergence)', () => {
    const { toAdd, toRevoke } = partitionRoles(['r1', 'r2'], ['r1', 'r3'])
    expect(toAdd).toEqual(['r2'])
    expect(toRevoke).toEqual(['r3'])
  })

  it('produces no changes when declared equals live', () => {
    const { toAdd, toRevoke } = partitionRoles(['r1', 'r2'], ['r2', 'r1'])
    expect(toAdd).toHaveLength(0)
    expect(toRevoke).toHaveLength(0)
  })

  it('revokes everything when the declared set is empty', () => {
    const { toAdd, toRevoke } = partitionRoles([], ['r1', 'r2'])
    expect(toAdd).toHaveLength(0)
    expect(toRevoke).toEqual(['r1', 'r2'])
  })
})

describe('collectRoleIds', () => {
  it('flattens a role_ids array', () => {
    expect(collectRoleIds([{ id: `${UG}:${CG}`, role_ids: ['r1', 'r2'] }])).toEqual(['r1', 'r2'])
  })

  it('flattens singular role_id resources and de-duplicates', () => {
    expect(
      collectRoleIds([
        { id: `${UG}:${CG}`, role_id: 'r1' },
        { id: `${UG}:${CG}`, role_id: 'r2' },
        { id: `${UG}:${CG}`, role_id: 'r1' },
      ]),
    ).toEqual(['r1', 'r2'])
  })

  it('returns empty for no resources', () => {
    expect(collectRoleIds([])).toHaveLength(0)
  })
})

describe('dedupe', () => {
  it('preserves order and drops repeats and blanks', () => {
    expect(dedupe(['a', 'b', 'a', '  ', 'c'])).toEqual(['a', 'b', 'c'])
  })
})
