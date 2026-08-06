import validate from '../validate'
import { buildPushEventSettingsBody, extractPushEventSettingsSpec, priorAsBody, pushEventSettingsMatch } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'bitdefender-gravityzone',
    customerId: 'cust-1',
    configTypeId: 'push-event-settings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'bitdefender-gravityzone',
      entityType: 'push-event-settings',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validFields = {
  status: '1',
  serviceType: 'jsonRPC',
  serviceSettings: '{"url":"https://siem.internal/hook"}',
  subscribeToEventTypes: ['av', 'fw'],
}

describe('GravityZone Push Event Settings Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed singleton', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an undocumented serviceType', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { ...validFields, serviceType: 'sumo' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SERVICE_TYPE')).toBe(true)
  })

  it('requires serviceSettings', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { ...validFields, serviceSettings: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED' && e.field.includes('serviceSettings'))).toBe(true)
  })

  it('rejects malformed serviceSettings JSON', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { ...validFields, serviceSettings: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('requires at least one subscribed event type', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { ...validFields, subscribeToEventTypes: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED' && e.field.includes('subscribeToEventTypes'))).toBe(true)
  })

  it('warns when more than one item is declared for this singleton', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'SINGLETON_EXCESS')).toBe(true)
  })
})

describe('GravityZone Push Event Settings shared helpers', () => {
  it('extractPushEventSettingsSpec reads the first item', () => {
    const spec = extractPushEventSettingsSpec(makeCtx([{ name: 'p', fields: validFields }]).canvas)
    expect(spec?.status).toBe(1)
    expect(spec?.serviceType).toBe('jsonRPC')
    expect(spec?.subscribeToEventTypes).toEqual(['av', 'fw'])
  })

  it('extractPushEventSettingsSpec returns null when no item is declared', () => {
    expect(extractPushEventSettingsSpec(makeCtx([]).canvas)).toBeNull()
  })

  it('buildPushEventSettingsBody always returns every required field', () => {
    const spec = extractPushEventSettingsSpec(makeCtx([{ name: 'p', fields: validFields }]).canvas)!
    const body = buildPushEventSettingsBody(spec, { url: 'https://siem.internal/hook' })
    expect(body).toEqual({ status: 1, serviceType: 'jsonRPC', serviceSettings: { url: 'https://siem.internal/hook' }, subscribeToEventTypes: ['av', 'fw'] })
  })

  it('pushEventSettingsMatch compares every field', () => {
    const spec = extractPushEventSettingsSpec(makeCtx([{ name: 'p', fields: validFields }]).canvas)!
    const live = { status: 1, serviceType: 'jsonRPC', serviceSettings: { url: 'https://siem.internal/hook' }, subscribeToEventTypes: ['fw', 'av'] }
    expect(pushEventSettingsMatch(spec, { url: 'https://siem.internal/hook' }, live)).toBe(true)
    expect(pushEventSettingsMatch(spec, { url: 'https://other' }, live)).toBe(false)
  })

  it('priorAsBody shapes a live response back into the required replacement body, defaulting missing fields', () => {
    expect(priorAsBody({})).toEqual({ status: 0, serviceType: 'jsonRPC', serviceSettings: {}, subscribeToEventTypes: [] })
  })
})
