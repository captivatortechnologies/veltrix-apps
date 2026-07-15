import validate, { extractUserGroupSpecs, MAX_USER_GROUP_NAME_LENGTH } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'user-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'user-groups',
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

describe('Tenable User Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid user group', async () => {
    const result = await validate(makeCtx([{ name: 'User Group', fields: { name: 'SOC-Analysts' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a blank (whitespace-only) name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '   ' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than the maximum', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(MAX_USER_GROUP_NAME_LENGTH + 1) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('accepts a name exactly at the maximum length', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(MAX_USER_GROUP_NAME_LENGTH) } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate group name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'SOC-Analysts' } },
        { name: 'sec2', fields: { name: 'SOC-Analysts' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('allows two distinct group names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'SOC-Analysts' } },
        { name: 'sec2', fields: { name: 'Auditors' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('treats names differing only in case as distinct (case-sensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'analysts' } },
        { name: 'sec2', fields: { name: 'Analysts' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractUserGroupSpecs', () => {
  it('trims the name field', () => {
    const specs = extractUserGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'user-groups',
      items: [],
      sections: [{ name: 'sec1', fields: { name: '  SOC-Analysts  ' } }],
      snapshot: {},
    })
    expect(specs[0].name).toBe('SOC-Analysts')
  })

  it('yields an empty name when the field is absent', () => {
    const specs = extractUserGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'user-groups',
      items: [],
      sections: [{ name: 'sec1', fields: {} }],
      snapshot: {},
    })
    expect(specs[0].name).toBe('')
  })
})
