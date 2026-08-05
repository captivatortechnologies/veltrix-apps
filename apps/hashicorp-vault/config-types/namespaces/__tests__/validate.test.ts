import validate, {
  extractNamespaceSpecs,
  normalizeNamespacePath,
  parseMetadataObject,
  resolveMetadata,
} from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'namespaces',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'namespaces',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'hashicorp-vault',
    entityType: 'namespaces',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Vault Namespaces Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid top-level namespace', async () => {
    const result = await validate(makeCtx([{ name: 'ns1', fields: { path: 'team-a' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid nested namespace', async () => {
    const result = await validate(makeCtx([{ name: 'ns1', fields: { path: 'team-a/dev' } }]))
    expect(result.valid).toBe(true)
  })

  it('validates a namespace with metadata', async () => {
    const result = await validate(makeCtx([{ name: 'ns1', fields: { path: 'team-a', customMetadataJson: '{"team":"platform"}' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing path', async () => {
    const result = await validate(makeCtx([{ name: 'ns1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('path'))).toBe(true)
  })

  it('rejects a path with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'ns1', fields: { path: 'bad path!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_path')).toBe(true)
  })

  it('rejects a duplicate path', async () => {
    const result = await validate(
      makeCtx([
        { name: 'ns1', fields: { path: 'team-a' } },
        { name: 'ns2', fields: { path: 'team-a' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_path')).toBe(true)
  })

  it('treats surrounding slashes as the same path for dedup', async () => {
    const result = await validate(
      makeCtx([
        { name: 'ns1', fields: { path: 'team-a' } },
        { name: 'ns2', fields: { path: '/team-a/' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_path')).toBe(true)
  })

  it('allows two distinct namespace paths', async () => {
    const result = await validate(
      makeCtx([
        { name: 'ns1', fields: { path: 'team-a' } },
        { name: 'ns2', fields: { path: 'team-b' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects malformed metadata JSON', async () => {
    const result = await validate(makeCtx([{ name: 'ns1', fields: { path: 'team-a', customMetadataJson: 'not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_metadata')).toBe(true)
  })

  it('rejects a non-string metadata value', async () => {
    const result = await validate(makeCtx([{ name: 'ns1', fields: { path: 'team-a', customMetadataJson: '{"count":1}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_metadata_value')).toBe(true)
  })
})

describe('extractNamespaceSpecs', () => {
  it('normalizes the path and drops a blank metadata field', () => {
    const specs = extractNamespaceSpecs(makeCanvas([{ name: 'ns1', fields: { path: '/team-a/', customMetadataJson: '   ' } }]))
    expect(specs[0].path).toBe('team-a')
    expect(specs[0].customMetadataJson).toBeUndefined()
  })
})

describe('normalizeNamespacePath', () => {
  it('strips surrounding slashes', () => {
    expect(normalizeNamespacePath('/team-a/')).toBe('team-a')
  })
  it('returns an empty string for non-strings', () => {
    expect(normalizeNamespacePath(undefined)).toBe('')
  })
})

describe('parseMetadataObject / resolveMetadata', () => {
  it('parses a valid object and rejects arrays/primitives', () => {
    expect(parseMetadataObject('{"a":"b"}')).toEqual({ a: 'b' })
    expect(parseMetadataObject('[1,2]')).toBeNull()
    expect(parseMetadataObject('nope')).toBeNull()
  })

  it('resolves to a string map', () => {
    expect(resolveMetadata('{"a":"b"}')).toEqual({ a: 'b' })
    expect(resolveMetadata(undefined)).toEqual({})
  })
})
