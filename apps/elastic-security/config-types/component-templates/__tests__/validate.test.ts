import validate, {
  extractTemplateSpecs,
  isManagedTemplate,
  isReservedTemplateName,
  parseJsonObject,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'component-templates',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'component-templates',
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

describe('Elastic Security Component Templates Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal template', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Template',
          fields: { name: 'app-logs-mappings', templateJson: '{"mappings":{"properties":{"host.name":{"type":"keyword"}}}}' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { templateJson: '{"mappings":{}}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a dot-prefixed name', async () => {
    const result = await validate(
      makeCtx([{ name: 't1', fields: { name: '.internal', templateJson: '{"mappings":{}}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_template')).toBe(true)
  })

  it('rejects a reserved built-in name', async () => {
    const result = await validate(
      makeCtx([{ name: 't1', fields: { name: 'logs-mappings', templateJson: '{"mappings":{}}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_template')).toBe(true)
  })

  it('rejects missing templateJson', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { name: 'app-logs' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('templateJson'))).toBe(true)
  })

  it('rejects invalid templateJson', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { name: 'app-logs', templateJson: 'not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_template')).toBe(true)
  })

  it('warns when the template defines none of mappings/settings/aliases', async () => {
    const result = await validate(
      makeCtx([{ name: 't1', fields: { name: 'app-logs', templateJson: '{"lifecycle":{"data_retention":"30d"}}' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'empty_template')).toBe(true)
  })

  it('rejects a duplicate template name', async () => {
    const result = await validate(
      makeCtx([
        { name: 't1', fields: { name: 'dup', templateJson: '{"mappings":{}}' } },
        { name: 't2', fields: { name: 'dup', templateJson: '{"mappings":{}}' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_template')).toBe(true)
  })
})

describe('extractTemplateSpecs', () => {
  it('trims fields and reads deprecated/version', () => {
    const specs = extractTemplateSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'component-templates',
      items: [],
      sections: [
        { name: 'sec1', fields: { name: '  app-logs  ', templateJson: '{"mappings":{}}', version: 2, deprecated: true } },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('app-logs')
    expect(specs[0].version).toBe(2)
    expect(specs[0].deprecated).toBe(true)
  })
})

describe('isReservedTemplateName', () => {
  it('flags dot/@-prefixed and built-in names', () => {
    expect(isReservedTemplateName('.internal')).toBe(true)
    expect(isReservedTemplateName('@custom')).toBe(true)
    expect(isReservedTemplateName('logs-settings')).toBe(true)
    expect(isReservedTemplateName('metrics-mappings')).toBe(true)
    expect(isReservedTemplateName('app-logs')).toBe(false)
  })
})

describe('parseJsonObject', () => {
  it('accepts objects only', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObject('[1,2]')).toBeNull()
    expect(parseJsonObject('not json')).toBeNull()
  })
})

describe('isManagedTemplate', () => {
  it('is true when component_template._meta.managed is true', () => {
    expect(isManagedTemplate({ name: 'x', component_template: { _meta: { managed: true } } })).toBe(true)
  })
  it('is false otherwise', () => {
    expect(isManagedTemplate({ name: 'x', component_template: {} })).toBe(false)
  })
})
