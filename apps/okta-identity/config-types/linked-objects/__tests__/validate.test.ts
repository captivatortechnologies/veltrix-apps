import validate, {
  extractLinkedObjectSpecs,
  buildLinkedObjectBody,
  LINKED_OBJECT_NAME_PATTERN,
} from '../validate'
import { linkedObjectMatches, type LinkedObjectRollbackEntry } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'linked-objects',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'linked-objects',
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
    entityType: 'linked-objects',
    items: sections,
    sections,
    snapshot: {},
  }
}

const VALID_FIELDS = {
  primaryName: 'manager',
  primaryTitle: 'Manager',
  associatedName: 'subordinate',
  associatedTitle: 'Subordinate',
}

describe('Okta Linked Objects Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a full valid definition', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Def',
          fields: {
            ...VALID_FIELDS,
            primaryDescription: 'The user this person reports to',
            associatedDescription: 'People who report to this user',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a definition with no descriptions', async () => {
    const result = await validate(makeCtx([{ name: 'Def', fields: { ...VALID_FIELDS } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a leading-underscore name', async () => {
    const result = await validate(
      makeCtx([{ name: 'Def', fields: { ...VALID_FIELDS, primaryName: '_manager', associatedName: '_report' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing primary name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, primaryName: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('primaryName'))).toBe(true)
  })

  it('rejects a missing associated name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, associatedName: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('associatedName'))).toBe(true)
  })

  it('rejects a primary name that starts with a digit', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, primaryName: '1manager' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name' && e.field.includes('primaryName'))).toBe(true)
  })

  it('rejects a primary name with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, primaryName: 'my-manager' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name' && e.field.includes('primaryName'))).toBe(true)
  })

  it('rejects an associated name with illegal characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, associatedName: 'sub ordinate' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name' && e.field.includes('associatedName'))).toBe(true)
  })

  it('rejects a missing primary title', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, primaryTitle: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('primaryTitle'))).toBe(true)
  })

  it('rejects a missing associated title', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, associatedTitle: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('associatedTitle'))).toBe(true)
  })

  it('rejects a primary name equal to the associated name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, primaryName: 'peer', associatedName: 'peer' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'same_name')).toBe(true)
  })

  it('rejects a duplicate primary name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { ...VALID_FIELDS, primaryName: 'Manager', associatedName: 'subordinate' } },
        { name: 'sec2', fields: { ...VALID_FIELDS, primaryName: 'manager', associatedName: 'report' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('LINKED_OBJECT_NAME_PATTERN', () => {
  it('accepts legal names and rejects illegal ones', () => {
    expect(LINKED_OBJECT_NAME_PATTERN.test('manager')).toBe(true)
    expect(LINKED_OBJECT_NAME_PATTERN.test('_a1_b2')).toBe(true)
    expect(LINKED_OBJECT_NAME_PATTERN.test('1manager')).toBe(false)
    expect(LINKED_OBJECT_NAME_PATTERN.test('my-manager')).toBe(false)
  })
})

describe('extractLinkedObjectSpecs', () => {
  it('trims fields and drops blank descriptions', () => {
    const specs = extractLinkedObjectSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            primaryName: '  manager  ',
            primaryTitle: '  Manager  ',
            primaryDescription: '   ',
            associatedName: '  subordinate  ',
            associatedTitle: '  Subordinate  ',
          },
        },
      ]),
    )
    expect(specs[0].primaryName).toBe('manager')
    expect(specs[0].primaryTitle).toBe('Manager')
    expect(specs[0].primaryDescription).toBeUndefined()
    expect(specs[0].associatedName).toBe('subordinate')
    expect(specs[0].associatedTitle).toBe('Subordinate')
    expect(specs[0].associatedDescription).toBeUndefined()
  })

  it('keeps a non-blank description', () => {
    const specs = extractLinkedObjectSpecs(
      makeCanvas([{ name: 'sec1', fields: { ...VALID_FIELDS, primaryDescription: 'reports to' } }]),
    )
    expect(specs[0].primaryDescription).toBe('reports to')
  })
})

describe('buildLinkedObjectBody', () => {
  it('sets type USER on both sides and omits blank descriptions', () => {
    const body = buildLinkedObjectBody({
      sectionName: 's',
      primaryName: 'manager',
      primaryTitle: 'Manager',
      associatedName: 'subordinate',
      associatedTitle: 'Subordinate',
    })
    expect(body).toEqual({
      primary: { name: 'manager', title: 'Manager', type: 'USER' },
      associated: { name: 'subordinate', title: 'Subordinate', type: 'USER' },
    })
  })

  it('includes descriptions when present', () => {
    const body = buildLinkedObjectBody({
      sectionName: 's',
      primaryName: 'manager',
      primaryTitle: 'Manager',
      primaryDescription: 'reports to',
      associatedName: 'subordinate',
      associatedTitle: 'Subordinate',
      associatedDescription: 'reported by',
    })
    expect(body).toEqual({
      primary: { name: 'manager', title: 'Manager', type: 'USER', description: 'reports to' },
      associated: { name: 'subordinate', title: 'Subordinate', type: 'USER', description: 'reported by' },
    })
  })
})

describe('linkedObjectMatches', () => {
  const spec = {
    sectionName: 's',
    primaryName: 'manager',
    primaryTitle: 'Manager',
    associatedName: 'subordinate',
    associatedTitle: 'Subordinate',
  }

  it('matches a live definition equal on both sides (name case-insensitive)', () => {
    const matches = linkedObjectMatches(spec, {
      primary: { name: 'Manager', title: 'Manager', type: 'USER' },
      associated: { name: 'Subordinate', title: 'Subordinate', type: 'USER' },
    })
    expect(matches).toBe(true)
  })

  it('does not match when a title differs', () => {
    const matches = linkedObjectMatches(spec, {
      primary: { name: 'manager', title: 'Boss', type: 'USER' },
      associated: { name: 'subordinate', title: 'Subordinate', type: 'USER' },
    })
    expect(matches).toBe(false)
  })

  it('does not match when the associated name differs', () => {
    const matches = linkedObjectMatches(spec, {
      primary: { name: 'manager', title: 'Manager', type: 'USER' },
      associated: { name: 'report', title: 'Subordinate', type: 'USER' },
    })
    expect(matches).toBe(false)
  })

  it('treats an absent description as an empty string', () => {
    const matches = linkedObjectMatches(spec, {
      primary: { name: 'manager', title: 'Manager', type: 'USER', description: '' },
      associated: { name: 'subordinate', title: 'Subordinate', type: 'USER' },
    })
    expect(matches).toBe(true)
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: LinkedObjectRollbackEntry | null = null
void _rollbackEntryType
