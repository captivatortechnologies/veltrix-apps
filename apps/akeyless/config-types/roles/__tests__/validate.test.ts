import validate, { extractRoleSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'akeyless',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'akeyless',
      entityType: 'roles',
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

describe('Akeyless Roles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal role with no rules or associations', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { name: 'ci-role' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate role name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'r1', fields: { name: 'ci-role' } },
        { name: 'r2', fields: { name: 'ci-role' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_role')).toBe(true)
  })

  it('validates a role with well-formed rules JSON', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'r1',
          fields: {
            name: 'ci-role',
            rules: JSON.stringify([{ path: '/services/*', ruleType: 'item-rule', capability: ['read', 'list'] }]),
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects malformed rules JSON', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { name: 'ci-role', rules: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.endsWith('.rules'))).toBe(true)
  })

  it('rejects a rule with no capabilities', async () => {
    const result = await validate(
      makeCtx([
        { name: 'r1', fields: { name: 'ci-role', rules: JSON.stringify([{ path: '/x', ruleType: 'item-rule', capability: [] }]) } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a rule with an invalid capability', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'r1',
          fields: { name: 'ci-role', rules: JSON.stringify([{ path: '/x', ruleType: 'item-rule', capability: ['fly'] }]) },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects a duplicate rule (same path + type)', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'r1',
          fields: {
            name: 'ci-role',
            rules: JSON.stringify([
              { path: '/x', ruleType: 'item-rule', capability: ['read'] },
              { path: '/x', ruleType: 'item-rule', capability: ['list'] },
            ]),
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('validates a role with well-formed auth-method associations JSON', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'r1',
          fields: {
            name: 'ci-role',
            authMethodAssociations: JSON.stringify([{ authMethodName: '/ci/runner', subClaims: { group: ['admins'] } }]),
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects malformed associations JSON', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { name: 'ci-role', authMethodAssociations: '[bad' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a duplicate association', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'r1',
          fields: {
            name: 'ci-role',
            authMethodAssociations: JSON.stringify([{ authMethodName: '/x' }, { authMethodName: '/x' }]),
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_association')).toBe(true)
  })
})

describe('extractRoleSpecs', () => {
  it('normalizes rules and defaults ruleType to item-rule', () => {
    const specs = extractRoleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'roles',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'r', rules: JSON.stringify([{ path: '/x', capability: ['read'] }]) } }],
      snapshot: {},
    })
    expect(specs[0].rules[0]).toEqual({ path: '/x', ruleType: 'item-rule', capability: ['read'] })
  })

  it('defaults to empty arrays when rules/associations are blank', () => {
    const specs = extractRoleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'roles',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'r' } }],
      snapshot: {},
    })
    expect(specs[0].rules).toEqual([])
    expect(specs[0].authMethodAssociations).toEqual([])
    expect(specs[0].rulesParseError).toBeNull()
  })
})
