import validate, { extractPrivilegeSpecs, parsePrivilegeDocument } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'onelogin',
    customerId: 'cust-1',
    configTypeId: 'privileges',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'onelogin',
      entityType: 'privileges',
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

const validStatement = '{"Version":"2018-05-18","Statement":[{"Effect":"Allow","Action":["users:Get"],"Scope":["*"]}]}'

describe('OneLogin Privileges Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid privilege', async () => {
    const result = await validate(makeCtx([{ name: 'Priv', fields: { name: 'User Reader', statementJson: validStatement } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid privilege with role/user assignment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Priv',
          fields: { name: 'User Reader', statementJson: validStatement, roleIds: ['1', '2'], userIds: ['10', '20'] },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { statementJson: validStatement } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate privilege name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'User Reader', statementJson: validStatement } },
        { name: 'sec2', fields: { name: 'User Reader', statementJson: validStatement } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_privilege')).toBe(true)
  })

  it('rejects a missing statement', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'User Reader' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('statementJson'))).toBe(true)
  })

  it('rejects a malformed statement', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'User Reader', statementJson: 'not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_statement')).toBe(true)
  })

  it('rejects a statement with a bad Effect value', async () => {
    const bad = '{"Version":"2018-05-18","Statement":[{"Effect":"Maybe","Action":["users:Get"],"Scope":["*"]}]}'
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'User Reader', statementJson: bad } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_statement')).toBe(true)
  })

  it('rejects an invalid roleId/userId', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'User Reader', statementJson: validStatement, roleIds: ['abc'], userIds: ['-1'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_role_id')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_user_id')).toBe(true)
  })
})

describe('extractPrivilegeSpecs', () => {
  it('parses roleIds/userIds into numbers', () => {
    const specs = extractPrivilegeSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onelogin',
      entityType: 'privileges',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'User Reader', roleIds: ['1', '2'], userIds: ['10'] } }],
      snapshot: {},
    })
    expect(specs[0].roleIds).toEqual([1, 2])
    expect(specs[0].userIds).toEqual([10])
  })
})

describe('parsePrivilegeDocument', () => {
  it('parses a well-formed document', () => {
    expect(parsePrivilegeDocument(validStatement)).toEqual({
      Version: '2018-05-18',
      Statement: [{ Effect: 'Allow', Action: ['users:Get'], Scope: ['*'] }],
    })
  })
  it('returns null for malformed JSON', () => {
    expect(parsePrivilegeDocument('not json')).toBeNull()
  })
  it('returns null when Statement is empty', () => {
    expect(parsePrivilegeDocument('{"Version":"2018-05-18","Statement":[]}')).toBeNull()
  })
  it('returns null when Version is missing', () => {
    expect(parsePrivilegeDocument('{"Statement":[{"Effect":"Allow","Action":["a"],"Scope":["*"]}]}')).toBeNull()
  })
  it('returns null when a statement Action is not all strings', () => {
    expect(parsePrivilegeDocument('{"Version":"v","Statement":[{"Effect":"Allow","Action":[1],"Scope":["*"]}]}')).toBeNull()
  })
})
