import validate, { extractScriptSpecs, normalizePlatforms } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'rtr-response-scripts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'rtr-response-scripts',
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

function validScriptFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Collect Prefetch',
    description: 'Collects Windows prefetch files for triage',
    platform: 'windows',
    permissionType: 'private',
    content: 'Get-ChildItem C:\\Windows\\Prefetch',
    ...overrides,
  }
}

describe('CrowdStrike RTR Custom Scripts Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid script configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Script', fields: validScriptFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing script name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validScriptFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing description', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validScriptFields({ description: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('description'))).toBe(
      true,
    )
  })

  it('rejects an unknown platform', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validScriptFields({ platform: 'solaris' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_platform')).toBe(true)
  })

  it('rejects an unknown permission type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validScriptFields({ permissionType: 'everyone' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_permission_type')).toBe(true)
  })

  it('rejects empty script content', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validScriptFields({ content: '   ' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('content'))).toBe(true)
  })

  it('normalizes platform and permission casing before checking the allowed sets', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validScriptFields({ platform: 'WINDOWS', permissionType: 'Public' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate script names across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validScriptFields() },
        { name: 'sec2', fields: validScriptFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects an over-long audit-log comment', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validScriptFields({ commentsForAuditLog: 'x'.repeat(4097) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })
})

describe('extractScriptSpecs', () => {
  it('trims name/description and lowercases platform and permission type', () => {
    const specs = extractScriptSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'rtr-response-scripts',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Collect Logs  ',
            description: '  triage  ',
            platform: 'LINUX',
            permissionType: 'GROUP',
            content: 'echo hi',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Collect Logs')
    expect(specs[0].description).toBe('triage')
    expect(specs[0].platform).toBe('linux')
    expect(specs[0].permissionType).toBe('group')
    expect(specs[0].content).toBe('echo hi')
  })

  it('defaults platform to windows and permission to private when unset', () => {
    const specs = extractScriptSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'rtr-response-scripts',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'x', content: 'y' } }],
      snapshot: {},
    })
    expect(specs[0].platform).toBe('windows')
    expect(specs[0].permissionType).toBe('private')
    expect(specs[0].commentsForAuditLog).toBeUndefined()
  })
})

describe('normalizePlatforms', () => {
  it('wraps a bare string into a lowercased single-element list', () => {
    expect(normalizePlatforms('Windows')).toEqual(['windows'])
  })
  it('lowercases and trims every element of an array', () => {
    expect(normalizePlatforms([' Mac ', 'LINUX'])).toEqual(['mac', 'linux'])
  })
  it('returns an empty list for undefined', () => {
    expect(normalizePlatforms(undefined)).toHaveLength(0)
  })
})
