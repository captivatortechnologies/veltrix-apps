import validate, {
  extractPluginSpecs,
  isValidPluginType,
  parseStringArray,
  pluginKey,
  PLUGIN_TYPES,
} from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const VALID_SHA = 'a'.repeat(64)

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'plugins',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'plugins',
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
    entityType: 'plugins',
    items: sections,
    sections,
    snapshot: {},
  }
}

/** A fully valid section's fields, overridable per test. */
function fields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'secret', name: 'my-plugin', sha256: VALID_SHA, command: 'vault-plugin-foo', ...overrides }
}

describe('Vault Plugins Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid plugin', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: fields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a plugin with version, args and env', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'P',
          fields: fields({
            version: 'v1.2.0',
            argsJson: '["--log-level","debug"]',
            envJson: '["API_HOST=example.com"]',
          }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing type', async () => {
    const f = fields()
    delete f.type
    const result = await validate(makeCtx([{ name: 'P', fields: f }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an invalid type', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: fields({ type: 'kv' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('accepts all three catalog types', async () => {
    for (const type of PLUGIN_TYPES) {
      const result = await validate(makeCtx([{ name: 'P', fields: fields({ type }) }]))
      expect(result.valid).toBe(true)
    }
  })

  it('rejects a missing name', async () => {
    const f = fields()
    delete f.name
    const result = await validate(makeCtx([{ name: 'P', fields: f }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: fields({ name: 'bad name!' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects a missing sha256', async () => {
    const f = fields()
    delete f.sha256
    const result = await validate(makeCtx([{ name: 'P', fields: f }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('sha256'))).toBe(true)
  })

  it('rejects a sha256 that is not 64 hex chars', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: fields({ sha256: 'abc123' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_sha256')).toBe(true)
  })

  it('rejects a sha256 with non-hex characters', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: fields({ sha256: 'g'.repeat(64) }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_sha256')).toBe(true)
  })

  it('accepts an upper-case sha256 (folded to lower-case)', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: fields({ sha256: 'A'.repeat(64) }) }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing command', async () => {
    const f = fields()
    delete f.command
    const result = await validate(makeCtx([{ name: 'P', fields: f }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('command'))).toBe(true)
  })

  it('rejects args that are not a JSON array', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: fields({ argsJson: '{"a":1}' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_args')).toBe(true)
  })

  it('rejects args that are a JSON array of non-strings', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: fields({ argsJson: '[1,2,3]' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_args')).toBe(true)
  })

  it('rejects env that is not a JSON array', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: fields({ envJson: 'API_HOST=x' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_env')).toBe(true)
  })

  it('rejects a duplicate (type, name) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'P1', fields: fields({ type: 'secret', name: 'foo' }) },
        { name: 'P2', fields: fields({ type: 'secret', name: 'foo' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_plugin')).toBe(true)
  })

  it('allows the same name under different types', async () => {
    const result = await validate(
      makeCtx([
        { name: 'P1', fields: fields({ type: 'secret', name: 'foo' }) },
        { name: 'P2', fields: fields({ type: 'auth', name: 'foo' }) },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractPluginSpecs', () => {
  it('lower-cases the type and sha256, trims fields, drops empty optionals', () => {
    const specs = extractPluginSpecs(
      makeCanvas([
        {
          name: 'P',
          fields: {
            type: '  SECRET  ',
            name: '  my-plugin  ',
            sha256: `  ${'A'.repeat(64)}  `,
            command: '  vault-plugin-foo  ',
            version: '  ',
            argsJson: '  ',
          },
        },
      ]),
    )
    expect(specs[0].type).toBe('secret')
    expect(specs[0].name).toBe('my-plugin')
    expect(specs[0].sha256).toBe('a'.repeat(64))
    expect(specs[0].command).toBe('vault-plugin-foo')
    expect(specs[0].version).toBeUndefined()
    expect(specs[0].argsJson).toBeUndefined()
  })
})

describe('isValidPluginType', () => {
  it('accepts the three catalog types', () => {
    expect(isValidPluginType('auth')).toBe(true)
    expect(isValidPluginType('database')).toBe(true)
    expect(isValidPluginType('secret')).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isValidPluginType('kv')).toBe(false)
    expect(isValidPluginType('')).toBe(false)
  })
})

describe('pluginKey', () => {
  it('joins type and name into the composite identity', () => {
    expect(pluginKey('auth', 'foo')).toBe('auth/foo')
  })
})

describe('parseStringArray', () => {
  it('parses a JSON array of strings', () => {
    expect(parseStringArray('["a","b"]')).toEqual(['a', 'b'])
    expect(parseStringArray('[]')).toEqual([])
  })
  it('returns null for objects, primitives and non-string elements', () => {
    expect(parseStringArray('{"a":1}')).toBeNull()
    expect(parseStringArray('"nope"')).toBeNull()
    expect(parseStringArray('[1,2]')).toBeNull()
    expect(parseStringArray('not json')).toBeNull()
  })
})
