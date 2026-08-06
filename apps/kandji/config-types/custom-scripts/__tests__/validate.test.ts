import validate, {
  buildCustomScriptBody,
  customScriptKey,
  extractCustomScriptSpecs,
  indexCustomScriptsByName,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'kandji',
    customerId: 'cust-1',
    configTypeId: 'custom-scripts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'kandji',
      entityType: 'custom-scripts',
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

const baseFields = {
  name: 'Enable Firewall',
  execution_frequency: 'once',
  script: '#!/bin/zsh\necho hi',
}

describe('Kandji Custom Scripts Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid custom script', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: baseFields }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { ...baseFields, name: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a missing script body', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { ...baseFields, script: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.script') && e.code === 'required')).toBe(true)
  })

  it('rejects an unsupported execution frequency', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { ...baseFields, execution_frequency: 'hourly' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_execution_frequency')).toBe(true)
  })

  it('requires a Self Service category id when Self Service is enabled', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { ...baseFields, show_in_self_service: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.self_service_category_id'))).toBe(true)
  })

  it('warns when a category id is set but Self Service is disabled', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { ...baseFields, self_service_category_id: 'cat-1' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'ignored_field')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: baseFields },
        { name: 'b', fields: { ...baseFields, name: 'enable firewall' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_custom_script')).toBe(true)
  })

  it('customScriptKey normalizes case and whitespace', () => {
    expect(customScriptKey('  Enable Firewall ')).toBe('enable firewall')
  })

  it('buildCustomScriptBody omits self-service fields when disabled', () => {
    const specs = extractCustomScriptSpecs(makeCtx([{ name: 'sec', fields: baseFields }]).canvas)
    expect(buildCustomScriptBody(specs[0])).toEqual({
      name: 'Enable Firewall',
      execution_frequency: 'once',
      script: '#!/bin/zsh\necho hi',
      active: true,
      restart: false,
      show_in_self_service: false,
    })
  })

  it('buildCustomScriptBody includes self-service fields when enabled', () => {
    const specs = extractCustomScriptSpecs(
      makeCtx([
        {
          name: 'sec',
          fields: { ...baseFields, show_in_self_service: true, self_service_category_id: 'cat-1', self_service_recommended: true },
        },
      ]).canvas,
    )
    const body = buildCustomScriptBody(specs[0])
    expect(body.self_service_category_id).toBe('cat-1')
    expect(body.self_service_recommended).toBe(true)
  })

  it('indexCustomScriptsByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexCustomScriptsByName([
      { id: '1', name: 'Dup' },
      { id: '2', name: 'dup' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })
})
