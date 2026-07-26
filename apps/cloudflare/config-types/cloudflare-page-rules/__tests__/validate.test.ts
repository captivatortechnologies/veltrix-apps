import validate, {
  actionIds,
  extractPageRuleSpecs,
  livePageRulePattern,
  pageRuleKey,
  parseJsonArray,
} from '../validate'
import { buildActions, buildPayload } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-page-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-page-rules',
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

const CACHE_ACTIONS = '[{"id":"cache_level","value":"cache_everything"}]'
const FORWARD_ACTIONS = '[{"id":"forwarding_url","value":{"url":"https://example.com/new","status_code":301}}]'

describe('Cloudflare Page Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a settings rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'Page Rule', fields: { url_pattern: '*example.com/images/*', actions_json: CACHE_ACTIONS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a forwarding rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'Page Rule', fields: { url_pattern: 'example.com/old', actions_json: FORWARD_ACTIONS } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing url pattern and missing actions', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('url_pattern'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('actions_json'))).toBe(true)
  })

  it('rejects invalid actions_json (object, not array)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { url_pattern: 'a', actions_json: '{"id":"x"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects an empty actions array', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { url_pattern: 'a', actions_json: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('actions_json'))).toBe(true)
  })

  it('rejects an action without an id', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { url_pattern: 'a', actions_json: '[{"value":"on"}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('rejects forwarding_url combined with other actions', async () => {
    const mixed = '[{"id":"forwarding_url","value":{"url":"https://x","status_code":301}},{"id":"cache_level","value":"bypass"}]'
    const result = await validate(makeCtx([{ name: 'sec1', fields: { url_pattern: 'a', actions_json: mixed } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'forwarding_conflict')).toBe(true)
  })

  it('rejects duplicate URL patterns (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { url_pattern: '*Example.com/A*', actions_json: CACHE_ACTIONS } },
        { name: 'b', fields: { url_pattern: '*example.com/a*', actions_json: CACHE_ACTIONS } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_page_rule')).toBe(true)
  })

  it('pageRuleKey + parseJsonArray + actionIds + extract behave', () => {
    expect(pageRuleKey('  *Example.com/*  ')).toBe('*example.com/*')
    expect(parseJsonArray('   ').error).toBeNull()
    expect(parseJsonArray('[1,2]').value).toEqual([1, 2])
    expect(parseJsonArray('nope').error).toBeTruthy()
    expect(parseJsonArray('{"a":1}').error).toBeTruthy()
    expect(actionIds([{ id: 'cache_level', value: 'x' }, { value: 'y' }, 'nope'])).toEqual(['cache_level'])
    const specs = extractPageRuleSpecs(makeCtx([{ name: 'r', fields: { url_pattern: ' *a* ' } }]).canvas)
    expect(specs[0].key).toBe('*a*')
    expect(specs[0].priority).toBe(1)
    expect(specs[0].enabled).toBe(true)
  })

  it('livePageRulePattern reads the url target constraint value', () => {
    expect(
      livePageRulePattern({ targets: [{ target: 'url', constraint: { operator: 'matches', value: '*x.com/*' } }] }),
    ).toBe('*x.com/*')
    expect(livePageRulePattern({ targets: [] })).toBe('')
  })

  it('buildPayload wraps the pattern as a single url target and maps enabled → status', () => {
    const spec = extractPageRuleSpecs(
      makeCtx([{ name: 'r', fields: { url_pattern: '*example.com/*', actions_json: CACHE_ACTIONS, priority: 3, enabled: false } }]).canvas,
    )[0]
    const payload = buildPayload(spec) as {
      targets: Array<{ target: string; constraint: { operator: string; value: string } }>
      actions: Array<{ id: string; value: unknown }>
      priority: number
      status: string
    }
    expect(payload.targets).toEqual([{ target: 'url', constraint: { operator: 'matches', value: '*example.com/*' } }])
    expect(payload.actions).toEqual([{ id: 'cache_level', value: 'cache_everything' }])
    expect(payload.priority).toBe(3)
    expect(payload.status).toBe('disabled')
  })

  it('buildActions keeps value only when present', () => {
    expect(buildActions([{ id: 'always_online', value: 'on' }, { id: 'disable_apps' }])).toEqual([
      { id: 'always_online', value: 'on' },
      { id: 'disable_apps' },
    ])
  })
})
