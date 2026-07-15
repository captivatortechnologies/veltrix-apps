import validate, {
  buildClaimBody,
  extractClaimSpecs,
  stripReadOnlyClaimFields,
  toBoolean,
  toStringList,
} from '../validate'
import { claimPath, claimsPath } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'auth-server-claims',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'auth-server-claims',
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
    entityType: 'auth-server-claims',
    items: sections,
    sections,
    snapshot: {},
  }
}

const EXPRESSION_FIELDS = {
  authServerId: 'default',
  name: 'department',
  claimType: 'RESOURCE',
  valueType: 'EXPRESSION',
  value: 'appuser.department',
  status: 'ACTIVE',
}

const GROUPS_FIELDS = {
  authServerId: 'default',
  name: 'groups',
  claimType: 'IDENTITY',
  valueType: 'GROUPS',
  value: '.*',
  groupFilterType: 'STARTS_WITH',
  scopeConditions: ['profile'],
}

describe('Okta Auth Server Claims Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid EXPRESSION claim', async () => {
    const result = await validate(makeCtx([{ name: 'Claim', fields: EXPRESSION_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid GROUPS claim with a group filter type', async () => {
    const result = await validate(makeCtx([{ name: 'Claim', fields: GROUPS_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a SYSTEM claim without a value', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Claim',
          fields: { authServerId: 'default', name: 'sub', claimType: 'IDENTITY', valueType: 'SYSTEM' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing authServerId', async () => {
    const { authServerId, ...rest } = EXPRESSION_FIELDS
    const result = await validate(makeCtx([{ name: 'sec1', fields: rest }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('authServerId'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const { name, ...rest } = EXPRESSION_FIELDS
    const result = await validate(makeCtx([{ name: 'sec1', fields: rest }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 1024 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...EXPRESSION_FIELDS, name: 'x'.repeat(1025) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing claimType', async () => {
    const { claimType, ...rest } = EXPRESSION_FIELDS
    const result = await validate(makeCtx([{ name: 'sec1', fields: rest }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('claimType'))).toBe(true)
  })

  it('rejects an unknown claimType', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...EXPRESSION_FIELDS, claimType: 'MAGIC' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_claim_type')).toBe(true)
  })

  it('rejects a missing valueType', async () => {
    const { valueType, ...rest } = EXPRESSION_FIELDS
    const result = await validate(makeCtx([{ name: 'sec1', fields: rest }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('valueType'))).toBe(true)
  })

  it('rejects an unknown valueType', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...EXPRESSION_FIELDS, valueType: 'MAGIC' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value_type')).toBe(true)
  })

  it('rejects an EXPRESSION claim with no value', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...EXPRESSION_FIELDS, value: '' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('value'))).toBe(true)
  })

  it('rejects a GROUPS claim with no value', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...GROUPS_FIELDS, value: '' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('value'))).toBe(true)
  })

  it('rejects a GROUPS claim with no group filter type', async () => {
    const { groupFilterType, ...rest } = GROUPS_FIELDS
    const result = await validate(makeCtx([{ name: 'sec1', fields: rest }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('groupFilterType'))).toBe(true)
  })

  it('rejects a GROUPS claim with an invalid group filter type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...GROUPS_FIELDS, groupFilterType: 'SOUNDS_LIKE' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_group_filter')).toBe(true)
  })

  it('warns (does not fail) when a group filter type is set on a non-GROUPS claim', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...EXPRESSION_FIELDS, groupFilterType: 'EQUALS' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'group_filter_ignored')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...EXPRESSION_FIELDS, status: 'PAUSED' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects a duplicate (authServerId, name) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: EXPRESSION_FIELDS },
        { name: 'sec2', fields: { ...EXPRESSION_FIELDS, value: 'appuser.title' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_claim')).toBe(true)
  })

  it('allows the same claim name under a different authorization server', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: EXPRESSION_FIELDS },
        { name: 'sec2', fields: { ...EXPRESSION_FIELDS, authServerId: 'aus1a2b3c4D5e6F7g8' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractClaimSpecs', () => {
  it('trims fields, upper-cases the enums, coerces the checkbox and parses tags', () => {
    const specs = extractClaimSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            authServerId: '  default  ',
            name: '  groups  ',
            claimType: ' identity ',
            valueType: '  groups ',
            value: '  .*  ',
            alwaysIncludeInToken: 'true',
            status: ' inactive ',
            scopeConditions: [' profile ', 'email'],
            groupFilterType: ' starts_with ',
          },
        },
      ]),
    )
    expect(specs[0].authServerId).toBe('default')
    expect(specs[0].name).toBe('groups')
    expect(specs[0].claimType).toBe('IDENTITY')
    expect(specs[0].valueType).toBe('GROUPS')
    expect(specs[0].value).toBe('.*')
    expect(specs[0].alwaysIncludeInToken).toBe(true)
    expect(specs[0].status).toBe('INACTIVE')
    expect(specs[0].scopeConditions).toEqual(['profile', 'email'])
    expect(specs[0].groupFilterType).toBe('STARTS_WITH')
  })

  it('defaults status to ACTIVE and alwaysIncludeInToken to false when unset', () => {
    const specs = extractClaimSpecs(
      makeCanvas([{ name: 'sec1', fields: { authServerId: 'default', name: 'x' } }]),
    )
    expect(specs[0].status).toBe('ACTIVE')
    expect(specs[0].alwaysIncludeInToken).toBe(false)
  })
})

describe('toBoolean', () => {
  it('passes booleans through and reads "true"/"false" strings', () => {
    expect(toBoolean(true)).toBe(true)
    expect(toBoolean(false)).toBe(false)
    expect(toBoolean('true')).toBe(true)
    expect(toBoolean(' TRUE ')).toBe(true)
    expect(toBoolean('false')).toBe(false)
    expect(toBoolean(undefined)).toBe(false)
  })
})

describe('toStringList', () => {
  it('normalises arrays and comma/newline text', () => {
    expect(toStringList(['a', ' b '])).toEqual(['a', 'b'])
    expect(toStringList('a, b\nc')).toEqual(['a', 'b', 'c'])
    expect(toStringList(undefined)).toEqual([])
  })
})

describe('buildClaimBody', () => {
  it('builds an EXPRESSION body with conditions.scopes and no group_filter_type', () => {
    const body = buildClaimBody({
      sectionName: 's',
      authServerId: 'default',
      name: 'department',
      claimType: 'RESOURCE',
      valueType: 'EXPRESSION',
      value: 'appuser.department',
      alwaysIncludeInToken: true,
      status: 'ACTIVE',
      scopeConditions: ['profile'],
      groupFilterType: '',
    })
    expect(body).toEqual({
      name: 'department',
      status: 'ACTIVE',
      claimType: 'RESOURCE',
      valueType: 'EXPRESSION',
      value: 'appuser.department',
      alwaysIncludeInToken: true,
      conditions: { scopes: ['profile'] },
    })
    expect(body.group_filter_type).toBeUndefined()
  })

  it('adds group_filter_type only for a GROUPS claim', () => {
    const body = buildClaimBody({
      sectionName: 's',
      authServerId: 'default',
      name: 'groups',
      claimType: 'IDENTITY',
      valueType: 'GROUPS',
      value: '.*',
      alwaysIncludeInToken: false,
      status: 'ACTIVE',
      scopeConditions: [],
      groupFilterType: 'STARTS_WITH',
    })
    expect(body.group_filter_type).toBe('STARTS_WITH')
    expect(body.conditions).toEqual({ scopes: [] })
  })

  it('omits value when blank (e.g. a SYSTEM claim)', () => {
    const body = buildClaimBody({
      sectionName: 's',
      authServerId: 'default',
      name: 'sub',
      claimType: 'IDENTITY',
      valueType: 'SYSTEM',
      value: '',
      alwaysIncludeInToken: false,
      status: 'ACTIVE',
      scopeConditions: [],
      groupFilterType: '',
    })
    expect(body.value).toBeUndefined()
    expect(body.valueType).toBe('SYSTEM')
  })

  it('defaults a blank status to ACTIVE', () => {
    const body = buildClaimBody({
      sectionName: 's',
      authServerId: 'default',
      name: 'department',
      claimType: 'RESOURCE',
      valueType: 'EXPRESSION',
      value: 'x',
      alwaysIncludeInToken: false,
      status: '',
      scopeConditions: [],
      groupFilterType: '',
    })
    expect(body.status).toBe('ACTIVE')
  })
})

describe('stripReadOnlyClaimFields', () => {
  it('removes id/created/lastUpdated/system/_links/_embedded but keeps status and the definition', () => {
    const stripped = stripReadOnlyClaimFields({
      id: 'oclabc',
      name: 'department',
      status: 'ACTIVE',
      claimType: 'RESOURCE',
      valueType: 'EXPRESSION',
      value: 'appuser.department',
      alwaysIncludeInToken: true,
      conditions: { scopes: [] },
      system: false,
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      _embedded: {},
    })
    expect(stripped).toEqual({
      name: 'department',
      status: 'ACTIVE',
      claimType: 'RESOURCE',
      valueType: 'EXPRESSION',
      value: 'appuser.department',
      alwaysIncludeInToken: true,
      conditions: { scopes: [] },
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.system).toBeUndefined()
    expect(stripped.status).toBe('ACTIVE')
  })
})

describe('claim path helpers', () => {
  it('builds the collection and single-claim paths, encoding ids', () => {
    expect(claimsPath('default')).toBe('/authorizationServers/default/claims')
    expect(claimPath('default', 'oclabc')).toBe('/authorizationServers/default/claims/oclabc')
  })
})
