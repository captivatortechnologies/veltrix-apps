import validate, {
  buildAttributesBody,
  extractProjectAttributesSpecs,
  projectKey,
  tagsArrayToRecord,
  tagsRecordToArray,
  toStringArray,
  toStringRecord,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-project-attributes',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-project-attributes',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { org_id: 'org-123' },
    platform: stubPlatform,
  }
}

describe('Snyk Project Attributes Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a project with only an id (everything else optional)', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { project_id: 'proj-1' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a project id', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('project_id'))).toBe(true)
  })

  it('validates a fully populated project', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'P',
          fields: {
            project_id: 'proj-1',
            business_criticality: ['high', 'medium'],
            environment: ['backend', 'internal'],
            lifecycle: ['production'],
            tags: { team: 'platform' },
            test_frequency: 'daily',
            owner_user_id: 'user-1',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an invalid business criticality', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { project_id: 'p', business_criticality: ['urgent'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_business_criticality')).toBe(true)
  })

  it('rejects an invalid environment', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { project_id: 'p', environment: ['space'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_environment')).toBe(true)
  })

  it('rejects an invalid lifecycle', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { project_id: 'p', lifecycle: ['staging'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_lifecycle')).toBe(true)
  })

  it('rejects an invalid test frequency', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { project_id: 'p', test_frequency: 'monthly' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_test_frequency')).toBe(true)
  })

  it('allows a blank test frequency (unmanaged)', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { project_id: 'p', test_frequency: '' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate project ids case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { project_id: 'proj-1' } },
        { name: 'b', fields: { project_id: 'PROJ-1' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_project')).toBe(true)
  })

  it('helpers behave', () => {
    expect(projectKey('  Proj-1 ')).toBe('proj-1')
    expect(toStringArray(['a', ' b ', 'a', ''])).toEqual(['a', 'b'])
    expect(toStringArray('a, b,, a')).toEqual(['a', 'b'])
    expect(toStringArray(undefined)).toEqual([])
    expect(toStringRecord({ team: 'platform', ' env ': 'prod' })).toEqual({ team: 'platform', env: 'prod' })
    expect(toStringRecord(null)).toEqual({})

    expect(tagsRecordToArray({ b: '2', a: '1' })).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ])
    expect(
      tagsArrayToRecord([
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
      ]),
    ).toEqual({ a: '1', b: '2' })
    expect(tagsArrayToRecord(undefined)).toEqual({})

    const spec = extractProjectAttributesSpecs(
      makeCtx([
        {
          name: 's',
          fields: {
            project_id: '  proj-1  ',
            business_criticality: ['high'],
            test_frequency: 'DAILY',
            owner_user_id: ' user-9 ',
          },
        },
      ]).canvas,
    )[0]
    expect(spec.projectId).toBe('proj-1')
    expect(spec.businessCriticality).toEqual(['high'])
    expect(spec.testFrequency).toBe('daily')
    expect(spec.ownerUserId).toBe('user-9')

    expect(
      buildAttributesBody({
        businessCriticality: ['high'],
        environment: [],
        lifecycle: [],
        tags: { a: '1' },
        testFrequency: '',
      }),
    ).toEqual({
      business_criticality: ['high'],
      environment: [],
      lifecycle: [],
      tags: [{ key: 'a', value: '1' }],
    })

    expect(
      buildAttributesBody({
        businessCriticality: [],
        environment: [],
        lifecycle: [],
        tags: {},
        testFrequency: 'weekly',
      }),
    ).toEqual({ business_criticality: [], environment: [], lifecycle: [], tags: [], test_frequency: 'weekly' })
  })
})
