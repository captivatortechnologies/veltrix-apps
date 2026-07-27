import validate, { extractMcpServerSpecs, splitEntries } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const valid = { name: 'Corp MCP', host: 'mcp.corp.com', port: 443, path: '/mcp', protocol: 'https' }

describe('aig-mcp-servers validate', () => {
  it('accepts a valid server', () => {
    const r = validate(ctxWith([{ name: 'Corp MCP', fields: { ...valid } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name, host, path and protocol', () => {
    const r = validate(ctxWith([{ name: '', fields: { port: 443 } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.host'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.path'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.protocol'))).toBe(true)
  })

  it('rejects an invalid port', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { ...valid, port: 0 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { ...valid, name: 'Dup' } },
        { name: 'Dup', fields: { ...valid, name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractMcpServerSpecs', () => {
  it('reads fields, port and capability lists', () => {
    const specs = extractMcpServerSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: 'Corp MCP', host: 'h', port: '8443', path: '/mcp', protocol: 'https', tools: 'search\nfetch' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].port).toBe(8443)
    expect(specs[0].tools).toEqual(['search', 'fetch'])
  })
})

describe('splitEntries', () => {
  it('splits arrays and delimited strings', () => {
    expect(splitEntries('a\nb')).toEqual(['a', 'b'])
    expect(splitEntries(['a', ' b '])).toEqual(['a', 'b'])
  })
})
