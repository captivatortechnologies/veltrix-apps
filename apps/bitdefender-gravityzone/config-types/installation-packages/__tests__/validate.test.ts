import validate from '../validate'
import {
  extractInstallationPackageSpecs,
  findLivePackage,
  installationPackageKey,
  livePackageId,
  packageFieldsMatch,
  parsePackageJsonFields,
} from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'bitdefender-gravityzone',
    customerId: 'cust-1',
    configTypeId: 'installation-packages',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'bitdefender-gravityzone',
      entityType: 'installation-packages',
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

const validFields = { packageName: 'Default Package', description: 'Base workstation package', language: 'en_US', productType: '0' }

describe('GravityZone Installation Packages Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed package', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires packageName', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { description: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED')).toBe(true)
  })

  it('warns on a duplicate packageName', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_PACKAGE')).toBe(true)
  })

  it('rejects an undocumented productType', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { ...validFields, productType: '7' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_PRODUCT_TYPE')).toBe(true)
  })

  it('rejects malformed Advanced JSON', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { ...validFields, modules: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })
})

describe('GravityZone Installation Packages shared helpers', () => {
  it('installationPackageKey trims and lower-cases', () => {
    expect(installationPackageKey('  Default Package  ')).toBe('default package')
  })

  it('extractInstallationPackageSpecs reads and trims every field', () => {
    const specs = extractInstallationPackageSpecs(
      makeCtx([{ name: 'p', fields: { ...validFields, packageName: '  Default Package  ' } }]).canvas,
    )
    expect(specs[0].packageName).toBe('Default Package')
    expect(specs[0].productType).toBe(0)
  })

  it('findLivePackage matches by name case-insensitively', () => {
    const live = [{ id: 'p-1', packageName: 'Default Package' }, { id: 'p-2', packageName: 'Legal' }]
    expect(findLivePackage(live, 'default package')?.id).toBe('p-1')
    expect(findLivePackage(live, 'missing')).toBeUndefined()
  })

  it('livePackageId reads id or packageId defensively', () => {
    expect(livePackageId({ id: 'p-1' })).toBe('p-1')
    expect(livePackageId({ packageId: 'p-2' })).toBe('p-2')
    expect(livePackageId({})).toBe('')
  })

  it('packageFieldsMatch compares scalars and JSON sub-objects', () => {
    const spec = {
      itemName: 'p',
      packageName: 'Default Package',
      description: 'desc',
      language: 'en_US',
      productType: 0,
      modulesRaw: '{"av":true}',
      scanModeRaw: '',
      settingsRaw: '',
      rolesRaw: '',
      deploymentOptionsRaw: '',
    }
    const parsed = parsePackageJsonFields(spec)
    expect(packageFieldsMatch(spec, parsed, { description: 'desc', language: 'en_US', productType: 0, modules: { av: true } })).toBe(true)
    expect(packageFieldsMatch(spec, parsed, { description: 'other', language: 'en_US', productType: 0, modules: { av: true } })).toBe(false)
  })

  it('parsePackageJsonFields collects every parse error rather than stopping at the first', () => {
    const spec = {
      itemName: 'p',
      packageName: 'Default Package',
      description: '',
      language: '',
      productType: 0,
      modulesRaw: '{bad',
      scanModeRaw: '{also bad',
      settingsRaw: '',
      rolesRaw: '',
      deploymentOptionsRaw: '',
    }
    const parsed = parsePackageJsonFields(spec)
    expect(parsed.errors).toHaveLength(2)
  })
})
