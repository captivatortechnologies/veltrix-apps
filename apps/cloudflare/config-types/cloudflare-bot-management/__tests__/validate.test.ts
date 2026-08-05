import validate, { extractBotManagementSpec, parseJsonObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-bot-management',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-bot-management',
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

describe('Cloudflare Bot Management Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates with only defaults applied', async () => {
    const result = await validate(makeCtx([{ name: 'bm', fields: {} }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates explicit valid values', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'bm',
          fields: {
            ai_bots_protection: 'only_on_ad_pages',
            crawler_protection: 'enabled',
            content_bots_protection: 'block',
            cf_robots_variant: 'policy_only',
            enable_js: false,
            using_latest_model: false,
            advanced_json: '{"fight_mode":true}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an invalid ai_bots_protection value', async () => {
    const result = await validate(makeCtx([{ name: 'bm', fields: { ai_bots_protection: 'nope' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value' && e.field.includes('ai_bots_protection'))).toBe(true)
  })

  it('rejects advanced_json that is not valid JSON', async () => {
    const result = await validate(makeCtx([{ name: 'bm', fields: { advanced_json: 'nope' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('extractBotManagementSpec applies documented defaults', () => {
    const spec = extractBotManagementSpec(makeCtx([{ name: 'bm', fields: {} }]).canvas)
    expect(spec).toBeTruthy()
    expect(spec?.aiBotsProtection).toBe('block')
    expect(spec?.crawlerProtection).toBe('disabled')
    expect(spec?.contentBotsProtection).toBe('disabled')
    expect(spec?.cfRobotsVariant).toBe('off')
    expect(spec?.enableJs).toBe(true)
    expect(spec?.usingLatestModel).toBe(true)
  })

  it('extractBotManagementSpec returns null when no section is declared', () => {
    expect(extractBotManagementSpec(makeCtx([]).canvas)).toBeNull()
  })

  it('parseJsonObject treats blank as an empty object and rejects arrays', () => {
    expect(parseJsonObject('').value).toEqual({})
    expect(parseJsonObject('{"fight_mode":true}').value).toEqual({ fight_mode: true })
    expect(parseJsonObject('[1,2]').error).toBeTruthy()
  })
})
