import validate from '../validate'
import { extractIntegrationSpecs, findLiveIntegration, integrationFieldsMatch, integrationKey, liveIntegrationId, parseSpecifics } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'bitdefender-gravityzone',
    customerId: 'cust-1',
    configTypeId: 'integrations',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'bitdefender-gravityzone',
      entityType: 'integrations',
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

const validFields = { name: 'vCenter Prod', type: '1', specifics: '{"host":"vcenter.internal"}' }

describe('GravityZone Integrations Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed integration', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { type: '1', specifics: '{}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED' && e.field.includes('name'))).toBe(true)
  })

  it('requires specifics', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'x', type: '1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED' && e.field.includes('specifics'))).toBe(true)
  })

  it('rejects an undocumented type', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, type: '99' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_TYPE')).toBe(true)
  })

  it('rejects malformed Specifics JSON', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, specifics: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('warns on a duplicate name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_INTEGRATION')).toBe(true)
  })
})

describe('GravityZone Integrations shared helpers', () => {
  it('integrationKey trims and lower-cases', () => {
    expect(integrationKey('  vCenter Prod  ')).toBe('vcenter prod')
  })

  it('extractIntegrationSpecs reads and trims every field', () => {
    const specs = extractIntegrationSpecs(makeCtx([{ name: 'i', fields: { ...validFields, name: '  vCenter Prod  ' } }]).canvas)
    expect(specs[0].name).toBe('vCenter Prod')
    expect(specs[0].type).toBe(1)
  })

  it('findLiveIntegration matches by name case-insensitively', () => {
    const live = [{ id: 'i-1', name: 'vCenter Prod' }, { id: 'i-2', name: 'Other' }]
    expect(findLiveIntegration(live, 'vcenter prod')?.id).toBe('i-1')
    expect(findLiveIntegration(live, 'missing')).toBeUndefined()
  })

  it('liveIntegrationId reads id or integrationId defensively', () => {
    expect(liveIntegrationId({ id: 'i-1' })).toBe('i-1')
    expect(liveIntegrationId({ integrationId: 'i-2' })).toBe('i-2')
    expect(liveIntegrationId({})).toBe('')
  })

  it('parseSpecifics parses a valid JSON object', () => {
    const { value, error } = parseSpecifics({ itemName: 'i', name: 'vCenter Prod', type: 1, specificsRaw: '{"host":"x"}' })
    expect(error).toBeNull()
    expect(value).toEqual({ host: 'x' })
  })

  it('integrationFieldsMatch compares name and specifics but never type', () => {
    const spec = { itemName: 'i', name: 'vCenter Prod', type: 1, specificsRaw: '{"host":"x"}' }
    const { value: specifics } = parseSpecifics(spec)
    expect(integrationFieldsMatch(spec, specifics, { name: 'vCenter Prod', type: 99, specifics: { host: 'x' } })).toBe(true)
    expect(integrationFieldsMatch(spec, specifics, { name: 'vCenter Prod', type: 1, specifics: { host: 'y' } })).toBe(false)
  })
})
