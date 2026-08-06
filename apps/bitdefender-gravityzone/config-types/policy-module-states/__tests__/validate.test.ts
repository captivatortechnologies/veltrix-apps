import validate from '../validate'
import { extractPolicyModuleStateSpecs, parseSettings } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'bitdefender-gravityzone',
    customerId: 'cust-1',
    configTypeId: 'policy-module-states',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'bitdefender-gravityzone',
      entityType: 'policy-module-states',
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

const validFields = { policyId: 'pol-1', settings: '{"antimalware":true,"firewall":false}' }

describe('GravityZone Policy Module States Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed declaration', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires policyId and settings', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED')).toHaveLength(2)
  })

  it('rejects malformed settings JSON', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { ...validFields, settings: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('warns on a duplicate policyId', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_POLICY')).toBe(true)
  })
})

describe('GravityZone Policy Module States shared helpers', () => {
  it('extractPolicyModuleStateSpecs reads and trims every field', () => {
    const specs = extractPolicyModuleStateSpecs(makeCtx([{ name: 'p', fields: { policyId: '  pol-1  ', settings: ' {"a":1} ' } }]).canvas)
    expect(specs[0].policyId).toBe('pol-1')
    expect(specs[0].settingsRaw).toBe('{"a":1}')
  })

  it('parseSettings parses a valid JSON object', () => {
    const { value, error } = parseSettings({ itemName: 'p', policyId: 'pol-1', settingsRaw: '{"antimalware":true}' })
    expect(error).toBeNull()
    expect(value).toEqual({ antimalware: true })
  })

  it('parseSettings rejects non-object JSON', () => {
    const { value, error } = parseSettings({ itemName: 'p', policyId: 'pol-1', settingsRaw: '[1,2,3]' })
    expect(value).toBeNull()
    expect(error).toContain('must be a JSON object')
  })
})
