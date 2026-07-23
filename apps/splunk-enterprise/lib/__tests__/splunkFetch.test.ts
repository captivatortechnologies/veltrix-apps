import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { splunkFetch, __setSplunkTransport } from '../splunkApi'

// =============================================================================
// splunkFetch's real node:http(s) transport — request framing.
//
// splunkd's management API serves a self-signed cert (handled elsewhere) and,
// crucially, its multipart parser for a .spl package upload rejects a
// chunked-encoded body ("Unparsable URI-encoded request data"). So the transport
// MUST send an explicit Content-Length (never Transfer-Encoding: chunked) for a
// body — matching what undici's fetch did before we swapped to node:http(s).
// These tests hit a real local http server to pin that framing.
// =============================================================================

interface Captured {
  method: string
  contentLength: string | undefined
  transferEncoding: string | undefined
  contentType: string | undefined
  bodyLength: number
  bodyEqualsSent: boolean
}

describe('splunkFetch transport framing', () => {
  let server: Server
  let port: number
  let lastSentBody: Buffer | null = null
  let captured: Captured | null = null

  before(async () => {
    // These tests exercise the real transport, so make sure a stub from another
    // test file (which shares this module registry) isn't still installed.
    __setSplunkTransport(null)
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        captured = {
          method: req.method ?? '',
          contentLength: req.headers['content-length'],
          transferEncoding: req.headers['transfer-encoding'],
          contentType: req.headers['content-type'],
          bodyLength: body.length,
          bodyEqualsSent: lastSentBody != null && body.equals(lastSentBody),
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('frames a binary (multipart) body with Content-Length, not chunked', async () => {
    // Bytes that would be corrupted if re-encoded as text — a real .spl is binary.
    lastSentBody = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x42])
    const res = await splunkFetch(`http://127.0.0.1:${port}/services/apps/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=----veltrixTEST' },
      body: lastSentBody,
    })
    assert.equal(res.ok, true)
    assert.equal(res.status, 200)
    assert.ok(captured, 'server captured the request')
    assert.equal(captured!.method, 'POST')
    assert.equal(captured!.contentLength, String(lastSentBody.length), 'Content-Length equals body byte length')
    assert.equal(captured!.transferEncoding, undefined, 'must NOT be chunked')
    assert.equal(captured!.contentType, 'multipart/form-data; boundary=----veltrixTEST')
    assert.equal(captured!.bodyEqualsSent, true, 'server received the exact bytes sent')
  })

  it('frames a string (form-urlencoded) body with its utf8 byte length', async () => {
    lastSentBody = Buffer.from('name=café&filename=1', 'utf8') // multi-byte char → length ≠ char count
    const res = await splunkFetch(`http://127.0.0.1:${port}/services/apps/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=café&filename=1',
    })
    assert.equal(res.ok, true)
    assert.equal(captured!.contentLength, String(lastSentBody.length))
    assert.equal(captured!.transferEncoding, undefined)
    assert.equal(captured!.bodyEqualsSent, true)
  })

  it('sends no body framing on a GET', async () => {
    lastSentBody = null
    const res = await splunkFetch(`http://127.0.0.1:${port}/services/server/info`, { method: 'GET' })
    assert.equal(res.ok, true)
    assert.equal(await res.text(), '{"ok":true}')
    assert.equal(captured!.method, 'GET')
    assert.equal(captured!.bodyLength, 0)
  })
})
