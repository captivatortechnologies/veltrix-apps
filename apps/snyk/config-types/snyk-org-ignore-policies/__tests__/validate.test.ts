import validate, { buildConditionsGroup, buildIgnoreAction, extractPolicySpecs, policyKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(
  sections: Array<{ name: string; fields: Record<string, unknown> }>,
  settings: Record<string, unknown> = { org_id: 'org-123' },
): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-org-ignore-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-org-ignore-policies',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings,
    platform: stubPlatform,
  }
}

const valid = { name: 'suppress-test-cve', finding_key: 'abc123', ignore_type: 'not-vulnerable' }

describe('Snyk Org Ignore Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid not-vulnerable policy', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { ...valid } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a name', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { finding_key: 'x', ignore_type: 'not-vulnerable' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('requires a finding key', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { name: 'p', ignore_type: 'not-vulnerable' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('finding_key'))).toBe(true)
  })

  it('rejects an unsupported ignore type', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { ...valid, ignore_type: 'magic' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_ignore_type')).toBe(true)
  })

  it('requires an expiry for a temporary ignore', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { ...valid, ignore_type: 'temporary-ignore' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required_expires')).toBe(true)
  })

  it('accepts a temporary ignore with an expiry', async () => {
    const result = await validate(
      makeCtx([{ name: 'P', fields: { ...valid, ignore_type: 'temporary-ignore', expires: '2026-12-31T00:00:00.000Z' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...valid, name: 'dup' } },
        { name: 'b', fields: { ...valid, name: 'DUP' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('warns when the configured API version is deprecated/sunsetting', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { ...valid } }], { org_id: 'org-123', api_version: '2024-10-15' }))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'policies_api_version_sunsetting')).toBe(true)
  })

  it('does not warn when the configured API version is current', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { ...valid } }], { org_id: 'org-123', api_version: '2026-03-25' }))
    expect(result.warnings.some((w) => w.code === 'policies_api_version_sunsetting')).toBe(false)
  })

  it('helpers behave', () => {
    expect(policyKey('  Suppress-Test  ')).toBe('suppress-test')

    const spec = extractPolicySpecs(
      makeCtx([{ name: 's', fields: { name: '  p1  ', finding_key: '  abc  ', ignore_type: 'wont-fix', reason: ' why ' } }]).canvas,
    )[0]
    expect(spec.name).toBe('p1')
    expect(spec.findingKey).toBe('abc')
    expect(spec.ignoreType).toBe('wont-fix')
    expect(spec.reason).toBe('why')

    expect(buildConditionsGroup('abc123')).toEqual({
      logical_operator: 'and',
      conditions: [{ field: 'snyk/asset/finding/v1', operator: 'includes', value: 'abc123' }],
    })

    expect(buildIgnoreAction({ ignoreType: 'not-vulnerable', reason: '', expires: '' })).toEqual({
      data: { ignore_type: 'not-vulnerable' },
    })
    expect(buildIgnoreAction({ ignoreType: 'temporary-ignore', reason: 'why', expires: '2026-01-01T00:00:00.000Z' })).toEqual({
      data: { ignore_type: 'temporary-ignore', reason: 'why', expires: '2026-01-01T00:00:00.000Z' },
    })
  })
})
