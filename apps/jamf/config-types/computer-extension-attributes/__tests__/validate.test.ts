import validate, {
  buildExtensionAttributeBody,
  extensionAttributeKey,
  extractExtensionAttributeSpecs,
  indexExtensionAttributesByName,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'jamf',
    customerId: 'cust-1',
    configTypeId: 'computer-extension-attributes',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jamf',
      entityType: 'computer-extension-attributes',
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

describe('Jamf Computer Extension Attributes Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a TEXT input-type attribute with just a name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Asset Tag' } }]))
    expect(result.valid).toBe(true)
  })

  it('validates a script-backed attribute with script contents', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { name: 'Encryption State', input_type: 'SCRIPT', script_contents: 'echo enabled' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a script input type with no script contents', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Encryption State', input_type: 'SCRIPT' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('script_contents') && e.code === 'required')).toBe(true)
  })

  it('rejects a popup input type with no choices', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Region', input_type: 'POPUP' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('popup_menu_choices'))).toBe(true)
  })

  it('accepts a popup input type with choices', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { name: 'Region', input_type: 'POPUP', popup_menu_choices: ['US', 'EU'] } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a directory-mapping input type with no LDAP attribute', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { name: 'Manager', input_type: 'DIRECTORY_SERVICE_ATTRIBUTE_MAPPING' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('ldap_attribute_mapping'))).toBe(true)
  })

  it('rejects an unsupported data type / input type / inventory display type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { name: 'x', data_type: 'BOOL', input_type: 'RADIO', inventory_display_type: 'MISC' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_data_type')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_input_type')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_inventory_display_type')).toBe(true)
  })

  it('rejects an unsupported manage_existing_data option', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'x', manage_existing_data: 'ARCHIVE' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_manage_existing_data')).toBe(true)
  })

  it('rejects duplicate attribute names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Asset Tag' } },
        { name: 'b', fields: { name: 'asset tag' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_extension_attribute')).toBe(true)
  })

  it('extensionAttributeKey normalizes case and whitespace', () => {
    expect(extensionAttributeKey('  Asset Tag ')).toBe('asset tag')
  })

  it('extractExtensionAttributeSpecs defaults dataType/inputType/inventoryDisplayType', () => {
    const specs = extractExtensionAttributeSpecs(makeCtx([{ name: 'sec', fields: { name: 'Asset Tag' } }]).canvas)
    expect(specs[0].dataType).toBe('STRING')
    expect(specs[0].inputType).toBe('TEXT')
    expect(specs[0].inventoryDisplayType).toBe('EXTENSION_ATTRIBUTES')
    expect(specs[0].enabled).toBe(true)
  })

  it('buildExtensionAttributeBody includes scriptContents only for SCRIPT input type', () => {
    const scriptSpecs = extractExtensionAttributeSpecs(
      makeCtx([{ name: 'sec', fields: { name: 'x', input_type: 'SCRIPT', script_contents: 'echo hi' } }]).canvas,
    )
    const scriptBody = buildExtensionAttributeBody(scriptSpecs[0])
    expect(scriptBody.scriptContents).toBe('echo hi')
    expect(scriptBody.popupMenuChoices).toBeUndefined()

    const textSpecs = extractExtensionAttributeSpecs(makeCtx([{ name: 'sec', fields: { name: 'x' } }]).canvas)
    expect(buildExtensionAttributeBody(textSpecs[0]).scriptContents).toBeUndefined()
  })

  it('buildExtensionAttributeBody includes popupMenuChoices only for POPUP input type', () => {
    const specs = extractExtensionAttributeSpecs(
      makeCtx([{ name: 'sec', fields: { name: 'x', input_type: 'POPUP', popup_menu_choices: ['A', 'B'] } }]).canvas,
    )
    expect(buildExtensionAttributeBody(specs[0]).popupMenuChoices).toEqual(['A', 'B'])
  })

  it('buildExtensionAttributeBody includes ldap fields only for DIRECTORY_SERVICE_ATTRIBUTE_MAPPING', () => {
    const specs = extractExtensionAttributeSpecs(
      makeCtx([
        {
          name: 'sec',
          fields: { name: 'x', input_type: 'DIRECTORY_SERVICE_ATTRIBUTE_MAPPING', ldap_attribute_mapping: 'manager', ldap_extension_attribute_allowed: true },
        },
      ]).canvas,
    )
    const body = buildExtensionAttributeBody(specs[0])
    expect(body.ldapAttributeMapping).toBe('manager')
    expect(body.ldapExtensionAttributeAllowed).toBe(true)
  })

  it('indexExtensionAttributesByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexExtensionAttributesByName([
      { id: '1', name: 'Dup' },
      { id: '2', name: 'dup' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })
})
