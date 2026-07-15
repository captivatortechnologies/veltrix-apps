import validate, {
  extractEnforcementSpecs,
  hasSelector,
  looksLikeUuid,
  splitList,
} from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'mfa-login-enforcement',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'mfa-login-enforcement',
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
    toolType: 'hashicorp-vault',
    entityType: 'mfa-login-enforcement',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Vault Login MFA Enforcement Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates an enforcement with a method id and an auth method type selector', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Enforcement',
          fields: { name: 'require-mfa', mfaMethodIds: [UUID_A], authMethodTypes: ['userpass'] },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates with an accessor selector', async () => {
    const result = await validate(
      makeCtx([
        { name: 'E', fields: { name: 'e1', mfaMethodIds: [UUID_A], authMethodAccessors: ['auth_userpass_1a2b3c4d'] } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates with an identity group id selector', async () => {
    const result = await validate(
      makeCtx([{ name: 'E', fields: { name: 'e1', mfaMethodIds: [UUID_A], identityGroupIds: [UUID_B] } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates with an identity entity id selector', async () => {
    const result = await validate(
      makeCtx([{ name: 'E', fields: { name: 'e1', mfaMethodIds: [UUID_A], identityEntityIds: [UUID_B] } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'E', fields: { mfaMethodIds: [UUID_A], authMethodTypes: ['userpass'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name with illegal characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'E', fields: { name: 'bad name!', mfaMethodIds: [UUID_A], authMethodTypes: ['userpass'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects an enforcement with no MFA method ids', async () => {
    const result = await validate(makeCtx([{ name: 'E', fields: { name: 'e1', authMethodTypes: ['userpass'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('mfaMethodIds'))).toBe(true)
  })

  it('rejects an enforcement with a method id but NO selector', async () => {
    const result = await validate(makeCtx([{ name: 'E', fields: { name: 'e1', mfaMethodIds: [UUID_A] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_selector')).toBe(true)
  })

  it('warns (but stays valid) when a method id is not a UUID', async () => {
    const result = await validate(
      makeCtx([{ name: 'E', fields: { name: 'e1', mfaMethodIds: ['not-a-uuid'], authMethodTypes: ['userpass'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'suspicious_method_id')).toBe(true)
  })

  it('warns when an identity group id is not a UUID', async () => {
    const result = await validate(
      makeCtx([{ name: 'E', fields: { name: 'e1', mfaMethodIds: [UUID_A], identityGroupIds: ['nope'] } }]),
    )
    expect(result.warnings.some((w) => w.code === 'suspicious_group_id')).toBe(true)
  })

  it('rejects a duplicate enforcement name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'E1', fields: { name: 'require-mfa', mfaMethodIds: [UUID_A], authMethodTypes: ['userpass'] } },
        { name: 'E2', fields: { name: 'Require-MFA', mfaMethodIds: [UUID_B], authMethodTypes: ['ldap'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows two distinct enforcements', async () => {
    const result = await validate(
      makeCtx([
        { name: 'E1', fields: { name: 'e1', mfaMethodIds: [UUID_A], authMethodTypes: ['userpass'] } },
        { name: 'E2', fields: { name: 'e2', mfaMethodIds: [UUID_B], identityGroupIds: [UUID_B] } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractEnforcementSpecs', () => {
  it('trims the name and de-dupes each id set', () => {
    const specs = extractEnforcementSpecs(
      makeCanvas([
        {
          name: 'E',
          fields: {
            name: '  require-mfa  ',
            mfaMethodIds: [UUID_A, UUID_A, UUID_B],
            authMethodTypes: ['userpass', 'userpass'],
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('require-mfa')
    expect(specs[0].mfaMethodIds).toEqual([UUID_A, UUID_B])
    expect(specs[0].authMethodTypes).toEqual(['userpass'])
    expect(specs[0].authMethodAccessors).toHaveLength(0)
  })

  it('splits a comma/newline string into separate ids', () => {
    const specs = extractEnforcementSpecs(
      makeCanvas([{ name: 'E', fields: { name: 'e1', mfaMethodIds: `${UUID_A}, ${UUID_B}` } }]),
    )
    expect(specs[0].mfaMethodIds).toEqual([UUID_A, UUID_B])
  })
})

describe('splitList', () => {
  it('handles arrays, strings and other types', () => {
    expect(splitList([' a ', 'b', ''])).toEqual(['a', 'b'])
    expect(splitList('a, b\nc')).toEqual(['a', 'b', 'c'])
    expect(splitList(undefined)).toHaveLength(0)
    expect(splitList(42)).toHaveLength(0)
  })
})

describe('looksLikeUuid', () => {
  it('accepts UUIDs and rejects other strings', () => {
    expect(looksLikeUuid(UUID_A)).toBe(true)
    expect(looksLikeUuid('  ' + UUID_B + '  ')).toBe(true)
    expect(looksLikeUuid('not-a-uuid')).toBe(false)
    expect(looksLikeUuid('userpass')).toBe(false)
  })
})

describe('hasSelector', () => {
  const base = {
    sectionName: 'E',
    name: 'e1',
    mfaMethodIds: [UUID_A],
    authMethodTypes: [],
    authMethodAccessors: [],
    identityGroupIds: [],
    identityEntityIds: [],
  }
  it('is false when every selector is empty', () => {
    expect(hasSelector(base)).toBe(false)
  })
  it('is true when any one selector is set', () => {
    expect(hasSelector({ ...base, authMethodTypes: ['userpass'] })).toBe(true)
    expect(hasSelector({ ...base, authMethodAccessors: ['auth_userpass_1'] })).toBe(true)
    expect(hasSelector({ ...base, identityGroupIds: [UUID_B] })).toBe(true)
    expect(hasSelector({ ...base, identityEntityIds: [UUID_B] })).toBe(true)
  })
})
