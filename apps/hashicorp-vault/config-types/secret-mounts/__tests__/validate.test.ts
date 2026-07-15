import validate, {
  extractMountSpecs,
  isProtectedMountPath,
  isValidVaultDuration,
  normalizeMountPath,
  parseDurationSeconds,
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
    configTypeId: 'secret-mounts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'secret-mounts',
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
    entityType: 'secret-mounts',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Vault Secret Engines Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid kv v2 mount', async () => {
    const result = await validate(
      makeCtx([{ name: 'Engine', fields: { path: 'secret', type: 'kv', kvVersion: '2' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid non-kv mount with tuning', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Engine',
          fields: { path: 'pki', type: 'pki', description: 'Internal CA', defaultLeaseTtl: '768h', maxLeaseTtl: '8760h' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing path', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'kv' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('path'))).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'secret' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects a path with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'bad path!', type: 'kv' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_path')).toBe(true)
  })

  it('rejects the reserved sys/ mount', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'sys', type: 'kv' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_path')).toBe(true)
  })

  it('rejects a path under the reserved identity/ mount', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'identity/entity', type: 'kv' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_path')).toBe(true)
  })

  it('rejects the reserved cubbyhole mount regardless of case or trailing slash', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'Cubbyhole/', type: 'kv' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_path')).toBe(true)
  })

  it('rejects an invalid KV version', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'secret', type: 'kv', kvVersion: '3' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_kv_version')).toBe(true)
  })

  it('warns (but stays valid) when a KV version is set on a non-kv engine', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'transit', type: 'transit', kvVersion: '2' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'kv_version_ignored')).toBe(true)
  })

  it('rejects an invalid lease TTL', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'secret', type: 'kv', defaultLeaseTtl: '10 hours' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_ttl')).toBe(true)
  })

  it('accepts a plain-seconds lease TTL', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'secret', type: 'kv', maxLeaseTtl: '3600' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a duplicate mount path', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { path: 'secret', type: 'kv' } },
        { name: 'sec2', fields: { path: 'secret', type: 'kv' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_path')).toBe(true)
  })

  it('treats surrounding slashes as the same path for dedup', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { path: 'secret', type: 'kv' } },
        { name: 'sec2', fields: { path: '/secret/', type: 'kv' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_path')).toBe(true)
  })

  it('allows two distinct mount paths', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { path: 'secret', type: 'kv' } },
        { name: 'sec2', fields: { path: 'pki', type: 'pki' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractMountSpecs', () => {
  it('normalizes the path, lower-cases the type, and drops empty optionals', () => {
    const specs = extractMountSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            path: '  /kv/prod/  ',
            type: '  KV  ',
            description: '  ',
            kvVersion: '2',
            defaultLeaseTtl: '',
          },
        },
      ]),
    )
    expect(specs[0].path).toBe('kv/prod')
    expect(specs[0].type).toBe('kv')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].kvVersion).toBe('2')
    expect(specs[0].defaultLeaseTtl).toBeUndefined()
  })
})

describe('normalizeMountPath', () => {
  it('strips surrounding slashes and collapses inner runs', () => {
    expect(normalizeMountPath('/secret/')).toBe('secret')
    expect(normalizeMountPath('kv//prod')).toBe('kv/prod')
  })
  it('returns an empty string for non-strings', () => {
    expect(normalizeMountPath(undefined)).toBe('')
    expect(normalizeMountPath(42)).toBe('')
  })
})

describe('isProtectedMountPath', () => {
  it('flags reserved built-in mounts and their children', () => {
    expect(isProtectedMountPath('sys')).toBe(true)
    expect(isProtectedMountPath('identity/entity')).toBe(true)
    expect(isProtectedMountPath('cubbyhole')).toBe(true)
  })
  it('allows ordinary mount paths', () => {
    expect(isProtectedMountPath('secret')).toBe(false)
    expect(isProtectedMountPath('systems')).toBe(false)
  })
})

describe('isValidVaultDuration', () => {
  it('accepts durations and plain seconds', () => {
    expect(isValidVaultDuration('768h')).toBe(true)
    expect(isValidVaultDuration('1h30m')).toBe(true)
    expect(isValidVaultDuration('3600')).toBe(true)
  })
  it('rejects malformed durations', () => {
    expect(isValidVaultDuration('10 hours')).toBe(false)
    expect(isValidVaultDuration('')).toBe(false)
    expect(isValidVaultDuration('abc')).toBe(false)
  })
})

describe('parseDurationSeconds', () => {
  it('parses plain seconds and unit durations', () => {
    expect(parseDurationSeconds('3600')).toBe(3600)
    expect(parseDurationSeconds('1h')).toBe(3600)
    expect(parseDurationSeconds('1h30m')).toBe(5400)
    expect(parseDurationSeconds('1d')).toBe(86400)
  })
  it('returns undefined for blank or unparseable input', () => {
    expect(parseDurationSeconds(undefined)).toBeUndefined()
    expect(parseDurationSeconds('')).toBeUndefined()
    expect(parseDurationSeconds('nope')).toBeUndefined()
  })
})
