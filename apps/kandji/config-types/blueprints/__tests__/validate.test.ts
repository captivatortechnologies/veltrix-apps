import validate, {
  blueprintKey,
  buildBlueprintCreateBody,
  buildBlueprintUpdateBody,
  extractBlueprintSpecs,
  indexBlueprintsByName,
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
    configTypeId: 'blueprints',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'kandji',
      entityType: 'blueprints',
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

describe('Kandji Blueprints Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid classic Blueprint', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { name: 'Default Blueprint', type: 'classic' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { type: 'classic' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Blueprint A', type: 'weird' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('warns when icon/color are set on an Assignment Map Blueprint', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { name: 'Map A', type: 'map', icon: 'ss-files', color: 'aqua-800' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'ignored_for_map')).toBe(true)
  })

  it('rejects duplicate Blueprint names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Default Blueprint', type: 'classic' } },
        { name: 'b', fields: { name: 'default blueprint', type: 'classic' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_blueprint')).toBe(true)
  })

  it('blueprintKey normalizes case and whitespace', () => {
    expect(blueprintKey('  Default Blueprint ')).toBe('default blueprint')
  })

  it('buildBlueprintCreateBody includes type and required enrollment flag', () => {
    const specs = extractBlueprintSpecs(
      makeCtx([{ name: 'sec', fields: { name: 'Sales', type: 'classic', enrollment_active: false } }]).canvas,
    )
    expect(buildBlueprintCreateBody(specs[0])).toEqual({
      name: 'Sales',
      type: 'classic',
      'enrollment_code.is_active': 'false',
    })
  })

  it('buildBlueprintCreateBody includes optional fields only when set', () => {
    const specs = extractBlueprintSpecs(
      makeCtx([
        {
          name: 'sec',
          fields: {
            name: 'Sales',
            type: 'map',
            description: 'Sales team',
            icon: 'ss-files',
            color: 'aqua-800',
            enrollment_code: '123456',
          },
        },
      ]).canvas,
    )
    expect(buildBlueprintCreateBody(specs[0])).toEqual({
      name: 'Sales',
      type: 'map',
      'enrollment_code.is_active': 'true',
      description: 'Sales team',
      icon: 'ss-files',
      color: 'aqua-800',
      'enrollment_code.code': '123456',
    })
  })

  it('buildBlueprintUpdateBody never includes type', () => {
    const specs = extractBlueprintSpecs(
      makeCtx([{ name: 'sec', fields: { name: 'Sales', type: 'classic' } }]).canvas,
    )
    const body = buildBlueprintUpdateBody(specs[0])
    expect('type' in body).toBe(false)
    expect(body.name).toBe('Sales')
  })

  it('indexBlueprintsByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexBlueprintsByName([
      { id: '1', name: 'Dup' },
      { id: '2', name: 'dup' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })
})
