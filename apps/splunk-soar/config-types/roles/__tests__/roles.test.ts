import validate from '../validate'
import { buildRoleRecord, permsToMap, permFieldKey, PERMISSION_NAMES, ALL_PERM_FIELD_KEYS } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-soar',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-soar',
      entityType: 'roles',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function baseFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fields: Record<string, unknown> = { name: 'Analyst', description: 'Read-only analyst' }
  for (const key of ALL_PERM_FIELD_KEYS) fields[key] = false
  return { ...fields, ...overrides }
}

describe('Splunk SOAR Roles', () => {
  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: baseFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NAME')).toBe(true)
  })

  it('rejects a missing description', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: baseFields({ description: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_DESCRIPTION')).toBe(true)
  })

  it('validates a fully-populated role', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: baseFields() }]))
    expect(result.valid).toBe(true)
  })

  it('warns on a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: baseFields() },
        { name: 'sec2', fields: baseFields() },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('buildRoleRecord builds all 9 permission categories with 4 flags each', () => {
    const spec = buildRoleRecord(baseFields({ [permFieldKey('containers', 'view')]: true }))
    expect(spec.body?.permissions).toHaveLength(PERMISSION_NAMES.length)
    const containers = (spec.body?.permissions as Array<Record<string, unknown>>).find((p) => p.name === 'containers')
    expect(containers).toEqual({ name: 'containers', view: true, edit: false, delete: false, execute: false })
  })

  it('permsToMap is order-independent and fills missing categories as all-false', () => {
    const a = permsToMap([{ name: 'apps', view: true, edit: false, delete: false, execute: false }])
    const b = permsToMap([{ name: 'apps', view: true, edit: false, delete: false, execute: false }])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.assets).toEqual({ view: false, edit: false, delete: false, execute: false })
  })

  it('buildRoleRecord skips a blank name without erroring', () => {
    const spec = buildRoleRecord(baseFields({ name: '' }))
    expect(spec.id).toBe('')
    expect(spec.error).toBeNull()
  })
})
