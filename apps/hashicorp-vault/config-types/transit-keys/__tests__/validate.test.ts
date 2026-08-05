import validate, {
  extractTransitKeySpecs,
  normalizeMountPath,
  coerceBoolean,
  optionalNumber,
  isValidVaultDuration,
  parseDurationSeconds,
  keyKey,
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
    configTypeId: 'transit-keys',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'transit-keys',
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
    entityType: 'transit-keys',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Vault Transit Keys Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid key', async () => {
    const result = await validate(makeCtx([{ name: 'Key', fields: { mount: 'transit', name: 'app-data', type: 'aes256-gcm96' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a fully specified key', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Key',
          fields: {
            mount: 'transit',
            name: 'signing-key',
            type: 'ed25519',
            deletionAllowed: true,
            minDecryptionVersion: 1,
            minEncryptionVersion: 2,
            autoRotatePeriod: '720h',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing mount', async () => {
    const result = await validate(makeCtx([{ name: 'k1', fields: { name: 'key1', type: 'aes256-gcm96' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('mount'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'k1', fields: { mount: 'transit', type: 'aes256-gcm96' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(makeCtx([{ name: 'k1', fields: { mount: 'transit', name: 'key1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an invalid type', async () => {
    const result = await validate(makeCtx([{ name: 'k1', fields: { mount: 'transit', name: 'key1', type: 'des' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects convergent encryption without derived', async () => {
    const result = await validate(
      makeCtx([{ name: 'k1', fields: { mount: 'transit', name: 'key1', type: 'aes256-gcm96', convergentEncryption: true, derived: false } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'convergent_requires_derived')).toBe(true)
  })

  it('accepts convergent encryption with derived', async () => {
    const result = await validate(
      makeCtx([{ name: 'k1', fields: { mount: 'transit', name: 'key1', type: 'aes256-gcm96', convergentEncryption: true, derived: true } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns when key size is set on a non-hmac key', async () => {
    const result = await validate(makeCtx([{ name: 'k1', fields: { mount: 'transit', name: 'key1', type: 'aes256-gcm96', keySize: 64 } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'key_size_ignored')).toBe(true)
  })

  it('rejects an out-of-range key size', async () => {
    const result = await validate(makeCtx([{ name: 'k1', fields: { mount: 'transit', name: 'key1', type: 'hmac', keySize: 8 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_key_size')).toBe(true)
  })

  it('rejects a negative min decryption version', async () => {
    const result = await validate(makeCtx([{ name: 'k1', fields: { mount: 'transit', name: 'key1', type: 'aes256-gcm96', minDecryptionVersion: -1 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_version')).toBe(true)
  })

  it('accepts "0" as auto rotate period (disabled)', async () => {
    const result = await validate(makeCtx([{ name: 'k1', fields: { mount: 'transit', name: 'key1', type: 'aes256-gcm96', autoRotatePeriod: '0' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an auto rotate period shorter than 1 hour', async () => {
    const result = await validate(makeCtx([{ name: 'k1', fields: { mount: 'transit', name: 'key1', type: 'aes256-gcm96', autoRotatePeriod: '30m' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'auto_rotate_too_short')).toBe(true)
  })

  it('rejects a malformed auto rotate period', async () => {
    const result = await validate(makeCtx([{ name: 'k1', fields: { mount: 'transit', name: 'key1', type: 'aes256-gcm96', autoRotatePeriod: 'weekly' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_duration')).toBe(true)
  })

  it('rejects a duplicate (mount, name)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'k1', fields: { mount: 'transit', name: 'dup', type: 'aes256-gcm96' } },
        { name: 'k2', fields: { mount: 'transit', name: 'dup', type: 'ed25519' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_key')).toBe(true)
  })

  it('allows the same key name under two different mounts', async () => {
    const result = await validate(
      makeCtx([
        { name: 'k1', fields: { mount: 'transit', name: 'app-key', type: 'aes256-gcm96' } },
        { name: 'k2', fields: { mount: 'transit_eu', name: 'app-key', type: 'aes256-gcm96' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractTransitKeySpecs', () => {
  it('normalizes mount, lower-cases type, and applies boolean defaults', () => {
    const specs = extractTransitKeySpecs(
      makeCanvas([{ name: 'k1', fields: { mount: '/transit/', name: '  app  ', type: '  AES256-GCM96  ' } }]),
    )
    expect(specs[0].mount).toBe('transit')
    expect(specs[0].name).toBe('app')
    expect(specs[0].type).toBe('aes256-gcm96')
    expect(specs[0].derived).toBe(false)
    expect(specs[0].exportable).toBe(false)
    expect(specs[0].deletionAllowed).toBe(false)
  })
})

describe('keyKey', () => {
  it('joins mount and name', () => {
    expect(keyKey('transit', 'app')).toBe('transit/app')
  })
})

describe('normalizeMountPath', () => {
  it('strips surrounding slashes', () => {
    expect(normalizeMountPath('/transit/')).toBe('transit')
  })
})

describe('coerceBoolean', () => {
  it('coerces common representations', () => {
    expect(coerceBoolean('true', false)).toBe(true)
    expect(coerceBoolean('false', true)).toBe(false)
  })
})

describe('optionalNumber', () => {
  it('parses numeric strings and passes numbers through', () => {
    expect(optionalNumber('64')).toBe(64)
    expect(optionalNumber(2)).toBe(2)
    expect(optionalNumber('')).toBeUndefined()
  })
})

describe('isValidVaultDuration', () => {
  it('accepts durations, plain seconds and zero', () => {
    expect(isValidVaultDuration('720h')).toBe(true)
    expect(isValidVaultDuration('0')).toBe(true)
  })
  it('rejects malformed durations', () => {
    expect(isValidVaultDuration('weekly')).toBe(false)
  })
})

describe('parseDurationSeconds', () => {
  it('parses durations to seconds', () => {
    expect(parseDurationSeconds('1h')).toBe(3600)
    expect(parseDurationSeconds('0')).toBe(0)
  })
})
