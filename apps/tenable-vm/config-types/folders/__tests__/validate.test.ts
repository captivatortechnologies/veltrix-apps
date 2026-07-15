import validate, { extractFolderSpecs, isSystemFolderName } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'folders',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'folders',
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

describe('Tenable Folders Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid folder', async () => {
    const result = await validate(makeCtx([{ name: 'Folder', fields: { name: 'Production Scans' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a blank (whitespace-only) name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '   ' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects the "My Scans" system folder', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'My Scans' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'system_folder')).toBe(true)
  })

  it('rejects the "Trash" system folder case-insensitively', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'trash' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'system_folder')).toBe(true)
  })

  it('rejects a duplicate folder name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Weekly' } },
        { name: 'sec2', fields: { name: 'Weekly' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_folder')).toBe(true)
  })

  it('allows two distinct folder names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Weekly' } },
        { name: 'sec2', fields: { name: 'Monthly' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractFolderSpecs', () => {
  it('trims the folder name', () => {
    const specs = extractFolderSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'folders',
      items: [],
      sections: [{ name: 'sec1', fields: { name: '  Production Scans  ' } }],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Production Scans')
  })

  it('yields an empty name when the field is absent', () => {
    const specs = extractFolderSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'folders',
      items: [],
      sections: [{ name: 'sec1', fields: {} }],
      snapshot: {},
    })
    expect(specs[0].name).toBe('')
  })
})

describe('isSystemFolderName', () => {
  it('matches the reserved names regardless of case or surrounding space', () => {
    expect(isSystemFolderName('My Scans')).toBe(true)
    expect(isSystemFolderName('  my scans ')).toBe(true)
    expect(isSystemFolderName('TRASH')).toBe(true)
  })
  it('does not match ordinary folder names', () => {
    expect(isSystemFolderName('My Scans 2024')).toBe(false)
    expect(isSystemFolderName('Production')).toBe(false)
  })
})
