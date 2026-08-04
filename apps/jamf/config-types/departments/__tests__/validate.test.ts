import validate, { buildDepartmentBody, departmentKey, extractDepartmentSpecs, indexDepartmentsByName } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'jamf',
    customerId: 'cust-1',
    configTypeId: 'departments',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jamf',
      entityType: 'departments',
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

describe('Jamf Departments Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid department', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Engineering' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name over 225 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'x'.repeat(226) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects duplicate department names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Engineering' } },
        { name: 'b', fields: { name: 'engineering' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_department')).toBe(true)
  })

  it('departmentKey normalizes case and whitespace', () => {
    expect(departmentKey('  Engineering ')).toBe('engineering')
  })

  it('buildDepartmentBody maps name', () => {
    const specs = extractDepartmentSpecs(makeCtx([{ name: 'sec', fields: { name: 'Sales' } }]).canvas)
    expect(buildDepartmentBody(specs[0])).toEqual({ name: 'Sales' })
  })

  it('indexDepartmentsByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexDepartmentsByName([
      { id: '1', name: 'Dup' },
      { id: '2', name: 'dup' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })
})
