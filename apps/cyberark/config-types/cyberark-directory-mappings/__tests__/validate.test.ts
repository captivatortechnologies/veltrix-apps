import validate, { extractDirectoryMappingSpecs, mappingKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-directory-mappings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-directory-mappings',
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

const validFields = { directory_name: 'CorpAD', mapping_name: 'Admins', domain_groups: ['CN=VaultAdmins,OU=Groups,DC=corp,DC=local'] }

describe('CyberArk Directory Mappings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal mapping', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires directory_name, mapping_name and at least one domain group', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('directory_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('mapping_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('domain_groups'))).toBe(true)
  })

  it('rejects an out-of-range logon hour', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, logon_from_hour: -1 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_hour')).toBe(true)
  })

  it('rejects duplicate (directory, mapping name) pairs case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields } },
        { name: 'b', fields: { ...validFields, mapping_name: validFields.mapping_name.toUpperCase() } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_mapping')).toBe(true)
  })

  it('extracts specs with a comma-separated tags fallback', () => {
    const specs = extractDirectoryMappingSpecs(
      makeCtx([{ name: 'a', fields: { ...validFields, vault_groups: 'VaultAdmins, SafeManagers' } }]).canvas,
    )
    expect(specs[0].vaultGroups).toEqual(['VaultAdmins', 'SafeManagers'])
    expect(mappingKey(specs[0])).toBe(mappingKey({ directoryName: 'corpad', mappingName: 'admins' }))
  })
})
