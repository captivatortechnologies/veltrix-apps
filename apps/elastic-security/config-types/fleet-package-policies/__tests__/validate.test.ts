import validate, { extractPolicySpecs, parseJsonArray, parseJsonObject, splitList } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'fleet-package-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'fleet-package-policies',
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

describe('Elastic Security Fleet Package Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal Elastic Defend policy', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Policy',
          fields: {
            name: 'Endpoint - Workstations',
            policyIds: ['agent-policy-1'],
            packageName: 'endpoint',
            packageVersion: '8.16.0',
            inputsJson: '[{"type":"endpoint","enabled":true,"streams":[]}]',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'p1', fields: { policyIds: ['a'], packageName: 'endpoint', packageVersion: '1.0.0', inputsJson: '[]' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects no agent policy ids', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { name: 'X', packageName: 'endpoint', packageVersion: '1.0.0', inputsJson: '[]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('policyIds'))).toBe(true)
  })

  it('rejects missing package name/version', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { name: 'X', policyIds: ['a'], inputsJson: '[]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('packageName'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('packageVersion'))).toBe(true)
  })

  it('rejects invalid inputsJson', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p1',
          fields: { name: 'X', policyIds: ['a'], packageName: 'endpoint', packageVersion: '1.0.0', inputsJson: 'not json' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_inputs')).toBe(true)
  })

  it('rejects a duplicate policy name (case-insensitive)', async () => {
    const base = { policyIds: ['a'], packageName: 'endpoint', packageVersion: '1.0.0', inputsJson: '[]' }
    const result = await validate(
      makeCtx([
        { name: 'p1', fields: { ...base, name: 'dup' } },
        { name: 'p2', fields: { ...base, name: 'DUP' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })
})

describe('extractPolicySpecs', () => {
  it('trims fields, defaults namespace and enabled', () => {
    const specs = extractPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'fleet-package-policies',
      items: [],
      sections: [{ name: 'sec1', fields: { name: '  Endpoint  ', policyIds: ['a', 'b'] } }],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Endpoint')
    expect(specs[0].namespace).toBe('default')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].policyIds).toEqual(['a', 'b'])
  })
})

describe('splitList / parseJsonArray / parseJsonObject', () => {
  it('splitList normalizes lists', () => {
    expect(splitList([' a ', '', 'b'])).toEqual(['a', 'b'])
    expect(splitList('a, b')).toEqual(['a', 'b'])
  })
  it('parseJsonArray accepts arrays only', () => {
    expect(parseJsonArray('[1]')).toEqual([1])
    expect(parseJsonArray('{}')).toBeNull()
  })
  it('parseJsonObject accepts objects only', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObject('[1]')).toBeNull()
  })
})
