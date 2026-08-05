import validate, { extractPostureRuleSpecs, parseJsonArray, parseJsonObject, postureRuleKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-device-posture-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-device-posture-rules',
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

const OS_VERSION_INPUT = '{"operating_system":"windows","operator":">=","version":"13.3.0"}'

describe('Cloudflare Device Posture Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid os_version rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'r1', fields: { name: 'Windows 11', type: 'os_version', input_json: OS_VERSION_INPUT } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { type: 'os_version', input_json: OS_VERSION_INPUT } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(
      makeCtx([{ name: 'r1', fields: { name: 'Bad', type: 'not-a-type', input_json: '{}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects a missing input_json', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { name: 'Windows 11', type: 'os_version' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('input_json'))).toBe(true)
  })

  it('rejects input_json that is not valid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'r1', fields: { name: 'Windows 11', type: 'os_version', input_json: 'nope' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.includes('input_json'))).toBe(true)
  })

  it('rejects match_json that is not a JSON array', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'r1',
          fields: { name: 'Windows 11', type: 'os_version', input_json: OS_VERSION_INPUT, match_json: '{}' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.includes('match_json'))).toBe(true)
  })

  it('rejects duplicate rule names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Windows 11', type: 'os_version', input_json: OS_VERSION_INPUT } },
        { name: 'b', fields: { name: 'windows 11', type: 'os_version', input_json: OS_VERSION_INPUT } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extractPostureRuleSpecs defaults type to os_version and trims name', () => {
    const specs = extractPostureRuleSpecs(
      makeCtx([{ name: 'r', fields: { name: '  Windows 11  ', input_json: OS_VERSION_INPUT } }]).canvas,
    )
    expect(specs[0].name).toBe('Windows 11')
    expect(specs[0].type).toBe('os_version')
  })

  it('postureRuleKey folds case; parseJsonObject/parseJsonArray treat blank as empty', () => {
    expect(postureRuleKey('Windows 11')).toBe(postureRuleKey('  windows 11  '))
    expect(parseJsonObject('').value).toEqual({})
    expect(parseJsonArray('').value).toEqual([])
    expect(parseJsonArray('[{"platform":"windows"}]').value).toEqual([{ platform: 'windows' }])
    expect(parseJsonArray('{}').error).toBeTruthy()
  })
})
