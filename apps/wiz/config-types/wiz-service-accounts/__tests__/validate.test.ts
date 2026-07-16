import validate, {
  extractServiceAccountSpecs,
  accountKey,
  sameStringSet,
  strList,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'wiz',
    customerId: 'cust-1',
    configTypeId: 'wiz-service-accounts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'wiz',
      entityType: 'wiz-service-accounts',
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

const validFields = {
  name: 'ci-readonly',
  type: 'THIRD_PARTY',
  scopes: ['read:projects', 'read:issues'],
}

describe('Wiz Service Accounts Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid THIRD_PARTY account', async () => {
    const result = await validate(makeCtx([{ name: 'Acct', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'THIRD_PARTY', scopes: ['read:projects'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, type: 'ROOT' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('requires at least one scope for a THIRD_PARTY account', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'api', type: 'THIRD_PARTY', scopes: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('scopes'))).toBe(true)
  })

  it('allows a non-THIRD_PARTY account with no scopes', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'sensor-1', type: 'SENSOR' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate account names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'CI Bot' } },
        { name: 'b', fields: { ...validFields, name: 'ci bot' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_account')).toBe(true)
  })

  it('extractServiceAccountSpecs trims, defaults type and reads tag lists', () => {
    const specs = extractServiceAccountSpecs(
      makeCtx([
        {
          name: 'e',
          fields: { name: '  Acct X  ', scopes: ['read:projects', '  read:issues  '], assigned_project_ids: 'p1, p2' },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Acct X')
    expect(specs[0].type).toBe('THIRD_PARTY')
    expect(specs[0].scopes).toEqual(['read:projects', 'read:issues'])
    expect(specs[0].assignedProjectIds).toEqual(['p1', 'p2'])
    expect(accountKey('  Acct X ')).toBe('acct x')
  })

  it('strList handles arrays, comma strings and blanks', () => {
    expect(strList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(strList('a, b ,')).toEqual(['a', 'b'])
    expect(strList(undefined)).toEqual([])
  })

  it('sameStringSet is order- and case-insensitive', () => {
    expect(sameStringSet(['read:projects', 'READ:issues'], ['read:issues', 'read:projects'])).toBe(true)
    expect(sameStringSet(['read:projects'], ['read:projects', 'read:issues'])).toBe(false)
  })
})
