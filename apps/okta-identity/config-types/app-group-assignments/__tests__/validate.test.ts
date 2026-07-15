import validate, {
  extractAppGroupAssignmentSpecs,
  parseJsonObject,
  toOptionalPriority,
} from '../validate'
import { buildAssignmentBody, stripReadOnlyAssignmentFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'app-group-assignments',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'app-group-assignments',
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
    entityType: 'app-group-assignments',
    items: sections,
    sections,
    snapshot: {},
  }
}

const VALID_FIELDS = { appId: '0oa1example', groupId: '00g1example' }

describe('Okta App Group Assignments Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully specified assignment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Assignment',
          fields: {
            appId: '0oa1example',
            groupId: '00g1example',
            priority: 5,
            profileJson: '{"role":"admin"}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a minimal assignment (appId + groupId only)', async () => {
    const result = await validate(makeCtx([{ name: 'Assignment', fields: { ...VALID_FIELDS } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing appId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { groupId: '00g1example' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('appId'))).toBe(true)
  })

  it('rejects a missing groupId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { appId: '0oa1example' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('groupId'))).toBe(true)
  })

  it('rejects a duplicate (appId, groupId) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { appId: '0oa1example', groupId: '00g1example' } },
        { name: 'sec2', fields: { appId: '0oa1example', groupId: '00g1example' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_assignment')).toBe(true)
  })

  it('allows the same group assigned to different apps', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { appId: '0oa1example', groupId: '00g1example' } },
        { name: 'sec2', fields: { appId: '0oa2other', groupId: '00g1example' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('allows the same app assigned to different groups', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { appId: '0oa1example', groupId: '00g1example' } },
        { name: 'sec2', fields: { appId: '0oa1example', groupId: '00g2other' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a profileJson that is not a JSON object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, profileJson: 'not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_profile')).toBe(true)
  })

  it('rejects a profileJson that is a JSON array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, profileJson: '["role"]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_profile')).toBe(true)
  })

  it('accepts a valid JSON object profileJson', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, profileJson: '{"role":"admin"}' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a non-numeric priority', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, priority: 'high' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('rejects a negative priority', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, priority: -1 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('accepts a zero priority', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, priority: 0 } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractAppGroupAssignmentSpecs', () => {
  it('trims fields, parses priority and drops a blank profileJson', () => {
    const specs = extractAppGroupAssignmentSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            appId: '  0oa1example  ',
            groupId: '  00g1example  ',
            priority: '5',
            profileJson: '  {"role":"admin"}  ',
          },
        },
      ]),
    )
    expect(specs[0].appId).toBe('0oa1example')
    expect(specs[0].groupId).toBe('00g1example')
    expect(specs[0].priority).toBe(5)
    expect(specs[0].profileJson).toBe('{"role":"admin"}')
  })

  it('leaves priority undefined and profileJson undefined when blank', () => {
    const specs = extractAppGroupAssignmentSpecs(
      makeCanvas([{ name: 'sec1', fields: { ...VALID_FIELDS, priority: '', profileJson: '   ' } }]),
    )
    expect(specs[0].priority).toBeUndefined()
    expect(specs[0].profileJson).toBeUndefined()
  })
})

describe('toOptionalPriority', () => {
  it('parses numbers and numeric strings, blank to undefined, non-numeric to NaN', () => {
    expect(toOptionalPriority(5)).toBe(5)
    expect(toOptionalPriority('5')).toBe(5)
    expect(toOptionalPriority(0)).toBe(0)
    expect(toOptionalPriority('')).toBeUndefined()
    expect(toOptionalPriority('   ')).toBeUndefined()
    expect(toOptionalPriority(undefined)).toBeUndefined()
    expect(toOptionalPriority(null)).toBeUndefined()
    expect(Number.isNaN(toOptionalPriority('high'))).toBe(true)
  })
})

describe('parseJsonObject', () => {
  it('returns the object for a JSON object and null for arrays/primitives/garbage', () => {
    expect(parseJsonObject('{"role":"admin"}')).toEqual({ role: 'admin' })
    expect(parseJsonObject('["role"]')).toBeNull()
    expect(parseJsonObject('"role"')).toBeNull()
    expect(parseJsonObject('42')).toBeNull()
    expect(parseJsonObject('not json')).toBeNull()
  })
})

describe('buildAssignmentBody', () => {
  it('returns an empty body when neither priority nor profile is set', () => {
    const body = buildAssignmentBody({ sectionName: 's', appId: '0oa1', groupId: '00g1' })
    expect(body).toEqual({})
    expect(body.priority).toBeUndefined()
    expect(body.profile).toBeUndefined()
  })

  it('includes priority when set (including zero) and parsed profile when present', () => {
    const body = buildAssignmentBody({
      sectionName: 's',
      appId: '0oa1',
      groupId: '00g1',
      priority: 0,
      profileJson: '{"role":"admin"}',
    })
    expect(body).toEqual({ priority: 0, profile: { role: 'admin' } })
  })

  it('omits profile when profileJson does not parse to an object', () => {
    const body = buildAssignmentBody({
      sectionName: 's',
      appId: '0oa1',
      groupId: '00g1',
      profileJson: '["role"]',
    })
    expect(body.profile).toBeUndefined()
  })
})

describe('stripReadOnlyAssignmentFields', () => {
  it('removes id/created/lastUpdated/_links/_embedded but keeps priority/profile', () => {
    const stripped = stripReadOnlyAssignmentFields({
      id: '00g1example',
      priority: 10,
      profile: { role: 'admin' },
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      _embedded: {},
    })
    expect(stripped).toEqual({ priority: 10, profile: { role: 'admin' } })
    expect(stripped.id).toBeUndefined()
    expect(stripped.lastUpdated).toBeUndefined()
  })
})
