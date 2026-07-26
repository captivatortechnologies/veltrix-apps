import validate, {
  extractIgnoreSpecs,
  ignoreKey,
  isValidDate,
  toIgnoreRule,
} from '../validate'
import { parseLiveIgnoreRules } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-project-ignores',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-project-ignores',
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

const valid = { project_id: 'p-1', issue_id: 'SNYK-JS-QS-10019', reason_type: 'wont-fix' }

describe('Snyk Project Ignores Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid ignore', async () => {
    const result = await validate(makeCtx([{ name: 'I', fields: { ...valid } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a project id and issue id', async () => {
    const result = await validate(makeCtx([{ name: 'I', fields: { reason_type: 'wont-fix' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('project_id'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('issue_id'))).toBe(true)
  })

  it('rejects an unsupported reason type', async () => {
    const result = await validate(makeCtx([{ name: 'I', fields: { ...valid, reason_type: 'because' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_reason_type')).toBe(true)
  })

  it('requires an expiry for a temporary ignore', async () => {
    const result = await validate(makeCtx([{ name: 'I', fields: { ...valid, reason_type: 'temporary-ignore' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'expires_required')).toBe(true)
  })

  it('accepts a temporary ignore with a valid expiry', async () => {
    const result = await validate(
      makeCtx([{ name: 'I', fields: { ...valid, reason_type: 'temporary-ignore', expires: '2026-12-31T23:59:59.000Z' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects an invalid expiry timestamp', async () => {
    const result = await validate(makeCtx([{ name: 'I', fields: { ...valid, expires: 'someday' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_expires')).toBe(true)
  })

  it('rejects a duplicate project+issue pair case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { project_id: 'P-1', issue_id: 'SNYK-1', reason_type: 'wont-fix' } },
        { name: 'b', fields: { project_id: 'p-1', issue_id: 'snyk-1', reason_type: 'not-vulnerable' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_ignore')).toBe(true)
  })

  it('allows the same issue id in different projects', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { project_id: 'p-1', issue_id: 'SNYK-1', reason_type: 'wont-fix' } },
        { name: 'b', fields: { project_id: 'p-2', issue_id: 'SNYK-1', reason_type: 'wont-fix' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('helpers behave', () => {
    expect(ignoreKey(' P-1 ', ' SNYK-1 ')).toBe('p-1::snyk-1')
    expect(isValidDate('2026-12-31T23:59:59.000Z')).toBe(true)
    expect(isValidDate('not-a-date')).toBe(false)

    const spec = extractIgnoreSpecs(
      makeCtx([{ name: 's', fields: { project_id: ' p ', issue_id: ' i ', disregard_if_fixable: 'true' } }]).canvas,
    )[0]
    expect(spec.projectId).toBe('p')
    expect(spec.issueId).toBe('i')
    expect(spec.ignorePath).toBe('*')
    expect(spec.reasonType).toBe('not-vulnerable')
    expect(spec.disregardIfFixable).toBe(true)

    const rule = toIgnoreRule({
      sectionName: 's',
      projectId: 'p',
      issueId: 'i',
      reasonType: 'temporary-ignore',
      reason: 'reviewed',
      ignorePath: '*',
      disregardIfFixable: false,
      expires: '2026-12-31T23:59:59.000Z',
    })
    expect(rule.reasonType).toBe('temporary-ignore')
    expect(rule.reason).toBe('reviewed')
    expect(rule.expires).toBe('2026-12-31T23:59:59.000Z')
  })

  it('parseLiveIgnoreRules reads the array and map v1 shapes and tolerates junk', () => {
    const arr = parseLiveIgnoreRules(
      JSON.stringify([{ '*': { reason: 'r', reasonType: 'wont-fix', disregardIfFixable: true } }]),
    )
    expect(arr).toHaveLength(1)
    expect(arr[0].ignorePath).toBe('*')
    expect(arr[0].reasonType).toBe('wont-fix')
    expect(arr[0].disregardIfFixable).toBe(true)

    const map = parseLiveIgnoreRules(
      JSON.stringify({ 'SNYK-1': [{ 'lib>dep': { reasonType: 'not-vulnerable' } }] }),
    )
    expect(map).toHaveLength(1)
    expect(map[0].ignorePath).toBe('lib>dep')

    expect(parseLiveIgnoreRules('')).toHaveLength(0)
    expect(parseLiveIgnoreRules('not json')).toHaveLength(0)
  })
})
