import validate, { extractScopeTagSpecs, scopeTagKey, isReservedName } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import { buildScopeTagBody, isBuiltInScopeTag } from '../deploy'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-scope-tags',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-scope-tags',
      items: [],
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: '00000000-0000-0000-0000-000000000000', azure_cloud: 'commercial' },
    platform: stubPlatform,
  }
}

const VALID_FIELDS = {
  name: 'Helpdesk EU',
  description: 'Scoping label for the EU helpdesk',
}

describe('Intune Role Scope Tags Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a well-formed scope tag', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: VALID_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('requires a scope tag name', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { description: 'no name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.name') && e.code === 'required')).toBe(true)
  })

  it('rejects duplicate scope tag names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Helpdesk EU' } },
        { name: 'b', fields: { name: 'HELPDESK EU' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_scope_tag')).toBe(true)
  })

  it('warns (non-blocking) on the reserved built-in name "Default"', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { name: 'Default' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings.some((w) => w.code === 'reserved_built_in')).toBe(true)
  })

  it('extract reads fields and trims the name', () => {
    const specs = extractScopeTagSpecs(
      makeCtx([{ name: 's', fields: { name: '  Helpdesk EU  ', description: '  a label  ' } }]).canvas,
    )
    expect(specs[0].name).toBe('Helpdesk EU')
    expect(specs[0].description).toBe('a label')
  })

  it('scopeTagKey trims and lowercases', () => {
    expect(scopeTagKey('  Helpdesk EU ')).toBe('helpdesk eu')
  })

  it('isReservedName matches "Default" case-insensitively only', () => {
    expect(isReservedName('Default')).toBe(true)
    expect(isReservedName('  default  ')).toBe(true)
    expect(isReservedName('DEFAULT')).toBe(true)
    expect(isReservedName('Helpdesk')).toBe(false)
  })

  it('isBuiltInScopeTag flags the built-in tag by isBuiltIn OR id "0"', () => {
    expect(isBuiltInScopeTag({ id: '0', displayName: 'Default' })).toBe(true)
    expect(isBuiltInScopeTag({ id: '5', isBuiltIn: true, displayName: 'Default' })).toBe(true)
    expect(isBuiltInScopeTag({ id: '7', isBuiltIn: false, displayName: 'Helpdesk EU' })).toBe(false)
    expect(isBuiltInScopeTag({ id: '7', displayName: 'Helpdesk EU' })).toBe(false)
  })

  it('builds a create/update body with displayName and description', () => {
    const specs = extractScopeTagSpecs(makeCtx([{ name: 's', fields: VALID_FIELDS }]).canvas)
    const body = buildScopeTagBody(specs[0]) as { '@odata.type': string; displayName: string; description: string }
    expect(body.displayName).toBe('Helpdesk EU')
    expect(body.description).toBe('Scoping label for the EU helpdesk')
    expect(body['@odata.type']).toBe('#microsoft.graph.roleScopeTag')
  })

  it('build body defaults a missing description to an empty string', () => {
    const specs = extractScopeTagSpecs(makeCtx([{ name: 's', fields: { name: 'No Desc' } }]).canvas)
    const body = buildScopeTagBody(specs[0]) as { displayName: string; description: string }
    expect(body.displayName).toBe('No Desc')
    expect(body.description).toBe('')
  })
})
