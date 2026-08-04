import validate, { buildPackageBody, extractPackageSpecs, indexPackagesByName, packageKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'jamf',
    customerId: 'cust-1',
    configTypeId: 'packages',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jamf',
      entityType: 'packages',
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

const validFields = {
  name: 'Security Agent',
  file_name: 'security-agent.pkg',
  category_name: 'Security',
  priority: 5,
}

describe('Jamf Packages Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid package', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: validFields }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { file_name: 'x.pkg', category_name: 'Security' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing file name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Agent', category_name: 'Security' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('file_name'))).toBe(true)
  })

  it('rejects a missing category name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Agent', file_name: 'x.pkg' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('category_name'))).toBe(true)
  })

  it('rejects a negative priority', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { ...validFields, priority: -1 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('defaults priority to 10 when omitted', () => {
    const specs = extractPackageSpecs(makeCtx([{ name: 'sec', fields: { name: 'x', file_name: 'y', category_name: 'z' } }]).canvas)
    expect(specs[0].priority).toBe(10)
  })

  it('rejects duplicate package names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Agent' } },
        { name: 'b', fields: { ...validFields, name: 'agent' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_package')).toBe(true)
  })

  it('packageKey normalizes case and whitespace', () => {
    expect(packageKey('  Security Agent ')).toBe('security agent')
  })

  it('extractPackageSpecs reads every installation-behavior flag', () => {
    const specs = extractPackageSpecs(
      makeCtx([
        {
          name: 'sec',
          fields: { ...validFields, reboot_required: true, suppress_eula: true, ignore_conflicts: true },
        },
      ]).canvas,
    )
    expect(specs[0].rebootRequired).toBe(true)
    expect(specs[0].suppressEula).toBe(true)
    expect(specs[0].ignoreConflicts).toBe(true)
    expect(specs[0].fillUserTemplate).toBe(false)
  })

  it('buildPackageBody maps fields and injects the resolved categoryId', () => {
    const specs = extractPackageSpecs(makeCtx([{ name: 'sec', fields: validFields }]).canvas)
    const body = buildPackageBody(specs[0], '7')
    expect(body.packageName).toBe('Security Agent')
    expect(body.fileName).toBe('security-agent.pkg')
    expect(body.categoryId).toBe('7')
    expect(body.priority).toBe(5)
    expect(body.installLanguage).toBeUndefined()
  })

  it('buildPackageBody includes installLanguage only when set', () => {
    const specs = extractPackageSpecs(makeCtx([{ name: 'sec', fields: { ...validFields, install_language: 'en' } }]).canvas)
    expect(buildPackageBody(specs[0], '7').installLanguage).toBe('en')
  })

  it('indexPackagesByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexPackagesByName([
      { id: '1', packageName: 'Dup' },
      { id: '2', packageName: 'dup' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })
})
