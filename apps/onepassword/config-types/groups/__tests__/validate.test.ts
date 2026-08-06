import validate, { extractGroupSpecs, toEmailList } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'onepassword',
    customerId: 'cust-1',
    configTypeId: 'groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'onepassword',
      entityType: 'groups',
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

describe('1Password Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a group with no members', async () => {
    const result = await validate(makeCtx([{ name: 'Group', fields: { displayName: 'Engineering' } }]))
    expect(result.valid).toBe(true)
  })

  it('validates a group with members', async () => {
    const result = await validate(
      makeCtx([{ name: 'Group', fields: { displayName: 'Engineering', memberUserNames: ['ada@example.com', 'grace@example.com'] } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing displayName', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate group name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { displayName: 'Engineering' } },
        { name: 'sec2', fields: { displayName: 'engineering' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('rejects a non-email member value', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { displayName: 'Engineering', memberUserNames: ['not-an-email'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_member_email')).toBe(true)
  })
})

describe('extractGroupSpecs', () => {
  it('de-dupes and trims member emails', () => {
    const specs = extractGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onepassword',
      entityType: 'groups',
      items: [],
      sections: [{ name: 'sec1', fields: { displayName: '  Engineering  ', memberUserNames: [' ada@example.com ', 'ada@example.com'] } }],
      snapshot: {},
    })
    expect(specs[0].displayName).toBe('Engineering')
    expect(specs[0].memberUserNames).toEqual(['ada@example.com'])
  })

  it('defaults memberUserNames to an empty array when absent', () => {
    const specs = extractGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onepassword',
      entityType: 'groups',
      items: [],
      sections: [{ name: 'sec1', fields: { displayName: 'Engineering' } }],
      snapshot: {},
    })
    expect(specs[0].memberUserNames).toEqual([])
  })
})

describe('toEmailList', () => {
  it('trims and filters array entries', () => {
    expect(toEmailList([' a@b.com ', '', 'c@d.com'])).toEqual(['a@b.com', 'c@d.com'])
  })
  it('splits comma/newline separated strings', () => {
    expect(toEmailList('a@b.com, c@d.com\ne@f.com')).toEqual(['a@b.com', 'c@d.com', 'e@f.com'])
  })
  it('returns an empty array for undefined/null', () => {
    expect(toEmailList(undefined)).toEqual([])
    expect(toEmailList(null)).toEqual([])
  })
})
