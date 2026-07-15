import validate, {
  extractPermissionSpecs,
  parseJsonArray,
  toStringList,
  OBJECT_ACTION_RULES,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'permissions',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'permissions',
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

const TAG_OBJECT = '[{"type":"Tag","uuid":"11111111-1111-1111-1111-111111111111"}]'
const ALL_ASSETS_OBJECT = '[{"type":"AllAssets"}]'
const USER_SUBJECT = '[{"type":"User","uuid":"22222222-2222-2222-2222-222222222222"}]'
const ALL_USERS_SUBJECT = '[{"type":"AllUsers"}]'

/** A valid Tag permission: Tag object pairs with CanUse, granted to a user. */
function validTagPermission(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Sec Team Prod Tag',
    actions: ['CanUse'],
    objectsJson: TAG_OBJECT,
    subjectsJson: USER_SUBJECT,
    ...overrides,
  }
}

describe('Tenable Permissions Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid Tag permission (Tag -> CanUse)', async () => {
    const result = await validate(makeCtx([{ name: 'Permission', fields: validTagPermission() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid AllAssets permission (AllAssets -> CanView) for AllUsers', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Permission',
          fields: {
            name: 'Read-only everyone',
            actions: ['CanView'],
            objectsJson: ALL_ASSETS_OBJECT,
            subjectsJson: ALL_USERS_SUBJECT,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts actions given as a comma-separated string', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Permission',
          fields: {
            name: 'Scanners',
            actions: 'CanView, CanScan',
            objectsJson: ALL_ASSETS_OBJECT,
            subjectsJson: ALL_USERS_SUBJECT,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ name: undefined }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects missing actions', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ actions: [] }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('actions'))).toBe(true)
  })

  it('rejects missing objects', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ objectsJson: undefined }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('objectsJson'))).toBe(true)
  })

  it('rejects missing subjects', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ subjectsJson: undefined }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('subjectsJson'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ name: 'x'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects objects that are a JSON object, not an array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ objectsJson: '{"type":"AllAssets"}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_objects')).toBe(true)
  })

  it('rejects malformed objects JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ objectsJson: '[not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_objects')).toBe(true)
  })

  it('rejects subjects that are a JSON object, not an array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ subjectsJson: '{"type":"AllUsers"}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_subjects')).toBe(true)
  })

  it('rejects a Tag object that is missing its uuid', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ objectsJson: '[{"type":"Tag"}]' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_objects')).toBe(true)
  })

  it('rejects a User subject that is missing its uuid', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ subjectsJson: '[{"type":"User"}]' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_subjects')).toBe(true)
  })

  it('rejects an incompatible pairing: Tag with CanView', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ actions: ['CanView'] }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_pairing')).toBe(true)
  })

  it('rejects an incompatible pairing: AllAssets with CanEdit', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'Bad AllAssets',
            actions: ['CanEdit'],
            objectsJson: ALL_ASSETS_OBJECT,
            subjectsJson: ALL_USERS_SUBJECT,
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_pairing')).toBe(true)
  })

  it('accepts the multi-action pairing Tag -> CanUse + CanEdit', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTagPermission({ actions: ['CanUse', 'CanEdit'] }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a duplicate permission name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validTagPermission({ name: 'Same' }) },
        { name: 'sec2', fields: validTagPermission({ name: 'Same' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_permission')).toBe(true)
  })

  it('allows two distinct permission names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validTagPermission({ name: 'One' }) },
        { name: 'sec2', fields: validTagPermission({ name: 'Two' }) },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractPermissionSpecs', () => {
  it('trims the name, parses actions, and drops empty JSON fields', () => {
    const specs = extractPermissionSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'permissions',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Admins  ',
            actions: ['  CanView  ', '', 'CanScan'],
            objectsJson: '  ',
            subjectsJson: '',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Admins')
    expect(specs[0].actions).toEqual(['CanView', 'CanScan'])
    expect(specs[0].objectsJson).toBeUndefined()
    expect(specs[0].subjectsJson).toBeUndefined()
  })
})

describe('parseJsonArray', () => {
  it('parses a JSON array', () => {
    expect(parseJsonArray('[{"type":"AllAssets"}]')).toEqual([{ type: 'AllAssets' }])
  })
  it('rejects a JSON object', () => {
    expect(parseJsonArray('{"type":"AllAssets"}')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseJsonArray('[nope')).toBe(null)
  })
})

describe('toStringList', () => {
  it('normalizes an array of strings', () => {
    expect(toStringList([' CanView ', '', 'CanScan'])).toEqual(['CanView', 'CanScan'])
  })
  it('splits a comma/newline-separated string', () => {
    expect(toStringList('CanView, CanScan')).toEqual(['CanView', 'CanScan'])
  })
  it('returns an empty list for non-string, non-array input', () => {
    expect(toStringList(undefined)).toHaveLength(0)
  })
})

describe('OBJECT_ACTION_RULES', () => {
  it('pairs Tag with CanUse/CanEdit and AllAssets with CanView/CanScan', () => {
    expect(OBJECT_ACTION_RULES.Tag).toEqual(['CanUse', 'CanEdit'])
    expect(OBJECT_ACTION_RULES.AllAssets).toEqual(['CanView', 'CanScan'])
  })
})
