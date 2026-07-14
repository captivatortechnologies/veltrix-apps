// =============================================================================
// multipart/form-data encoder.
//
// Two Splunk Cloud endpoints in this app take multipart bodies and nothing else:
//   - AppInspect submit ...... POST https://appinspect.splunk.com/v1/app/validate
//                              (app_package = the .spl, included_tags = private_*)
//   - ACS install (Classic) .. POST {acs}/{stack}/adminconfig/v2/apps
//                              (token = the AppInspect JWT, package = the .spl)
//
// Node's global FormData/Blob would work, but it hands fetch a stream whose
// boundary we cannot see; the handlers must be able to assert the exact bytes
// they send, so the body is built here as a plain Buffer.
// =============================================================================

import { randomBytes } from 'node:crypto'

/** A plain `name=value` form field. */
export interface MultipartField {
  name: string
  value: string
}

/** A file part — the bytes are sent verbatim. */
export interface MultipartFile {
  name: string
  fileName: string
  contentType: string
  bytes: Buffer | Uint8Array
}

export type MultipartPart = MultipartField | MultipartFile

export interface MultipartBody {
  body: Buffer
  contentType: string
  boundary: string
}

function isFile(part: MultipartPart): part is MultipartFile {
  return (part as MultipartFile).bytes !== undefined
}

/**
 * Encode parts as a multipart/form-data body.
 *
 * The boundary is random, so it cannot collide with content in the archive.
 * Field order is preserved: AppInspect and ACS both read the file part by name,
 * but keeping the order stable makes the request reproducible in a test.
 */
export function buildMultipartBody(
  parts: MultipartPart[],
  options: { boundary?: string } = {},
): MultipartBody {
  const boundary = options.boundary ?? `----veltrix${randomBytes(16).toString('hex')}`
  const chunks: Buffer[] = []

  for (const part of parts) {
    if (isFile(part)) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${part.name}"; filename="${part.fileName}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
          'utf8',
        ),
      )
      chunks.push(Buffer.from(part.bytes))
      chunks.push(Buffer.from('\r\n', 'utf8'))
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          'utf8',
        ),
      )
    }
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
    boundary,
  }
}
