import validate, {
  extractPkiRoleSpecs,
  normalizeMountPath,
  normalizeList,
  coerceBoolean,
  optionalNumber,
  isValidVaultDuration,
  roleKey,
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
    configTypeId: 'pki-roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'pki-roles',
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
    entityType: 'pki-roles',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Vault PKI Roles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid role', async () => {
    const result = await validate(makeCtx([{ name: 'Role', fields: { mount: 'pki', name: 'web-server' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a fully specified role', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Role',
          fields: {
            mount: 'pki_int',
            name: 'client-auth',
            ttl: '720h',
            maxTtl: '8760h',
            keyType: 'ec',
            keyBits: 256,
            allowedDomains: ['example.com'],
            allowSubdomains: true,
            notBeforeDuration: '30s',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing mount', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { name: 'role1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('mount'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { mount: 'pki' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a mount with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { mount: 'bad mount!', name: 'role1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_mount')).toBe(true)
  })

  it('rejects a name with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { mount: 'pki', name: 'bad name!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects an invalid key type', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { mount: 'pki', name: 'r', keyType: 'dsa' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_key_type')).toBe(true)
  })

  it('rejects a non-positive key bits', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { mount: 'pki', name: 'r', keyBits: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_key_bits')).toBe(true)
  })

  it('rejects an invalid ttl', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { mount: 'pki', name: 'r', ttl: '3 days' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_ttl')).toBe(true)
  })

  it('rejects an invalid notBeforeDuration', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { mount: 'pki', name: 'r', notBeforeDuration: 'nope' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_duration')).toBe(true)
  })

  it('rejects a duplicate (mount, name)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'r1', fields: { mount: 'pki', name: 'dup' } },
        { name: 'r2', fields: { mount: 'pki', name: 'dup' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_role')).toBe(true)
  })

  it('allows the same role name under two different mounts', async () => {
    const result = await validate(
      makeCtx([
        { name: 'r1', fields: { mount: 'pki', name: 'web-server' } },
        { name: 'r2', fields: { mount: 'pki_int', name: 'web-server' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractPkiRoleSpecs', () => {
  it('normalizes mount, trims fields, and applies documented boolean defaults', () => {
    const specs = extractPkiRoleSpecs(
      makeCanvas([{ name: 'r1', fields: { mount: '/pki/', name: '  web  ', keyType: '  RSA  ' } }]),
    )
    expect(specs[0].mount).toBe('pki')
    expect(specs[0].name).toBe('web')
    expect(specs[0].keyType).toBe('rsa')
    expect(specs[0].allowLocalhost).toBe(true)
    expect(specs[0].allowBareDomains).toBe(false)
    expect(specs[0].serverFlag).toBe(true)
    expect(specs[0].requireCn).toBe(true)
  })

  it('parses list fields from comma-separated text or arrays', () => {
    const specs = extractPkiRoleSpecs(
      makeCanvas([
        { name: 'r1', fields: { mount: 'pki', name: 'a', allowedDomains: 'example.com, example.org' } },
        { name: 'r2', fields: { mount: 'pki', name: 'b', keyUsage: ['DigitalSignature', 'KeyEncipherment'] } },
      ]),
    )
    expect(specs[0].allowedDomains).toEqual(['example.com', 'example.org'])
    expect(specs[1].keyUsage).toEqual(['DigitalSignature', 'KeyEncipherment'])
  })
})

describe('roleKey', () => {
  it('joins mount and name', () => {
    expect(roleKey('pki', 'web')).toBe('pki/web')
  })
})

describe('normalizeMountPath', () => {
  it('strips surrounding slashes', () => {
    expect(normalizeMountPath('/pki/')).toBe('pki')
  })
  it('returns empty string for non-strings', () => {
    expect(normalizeMountPath(undefined)).toBe('')
  })
})

describe('normalizeList', () => {
  it('splits comma/newline text and trims arrays', () => {
    expect(normalizeList('a, b,c')).toEqual(['a', 'b', 'c'])
    expect(normalizeList([' a ', 'b'])).toEqual(['a', 'b'])
    expect(normalizeList(undefined)).toEqual([])
  })
})

describe('coerceBoolean', () => {
  it('coerces common representations and falls back when unset', () => {
    expect(coerceBoolean('true', false)).toBe(true)
    expect(coerceBoolean('false', true)).toBe(false)
    expect(coerceBoolean(undefined, true)).toBe(true)
  })
})

describe('optionalNumber', () => {
  it('parses numeric strings and passes numbers through', () => {
    expect(optionalNumber('2048')).toBe(2048)
    expect(optionalNumber(256)).toBe(256)
    expect(optionalNumber('')).toBeUndefined()
    expect(optionalNumber(undefined)).toBeUndefined()
  })
  it('yields NaN for an unparseable value', () => {
    expect(Number.isNaN(optionalNumber('abc'))).toBe(true)
  })
})

describe('isValidVaultDuration', () => {
  it('accepts durations and plain seconds', () => {
    expect(isValidVaultDuration('720h')).toBe(true)
    expect(isValidVaultDuration('30s')).toBe(true)
    expect(isValidVaultDuration('3600')).toBe(true)
  })
  it('rejects malformed durations', () => {
    expect(isValidVaultDuration('3 days')).toBe(false)
    expect(isValidVaultDuration('')).toBe(false)
  })
})
