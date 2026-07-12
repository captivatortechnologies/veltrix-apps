// ============================================================================
// Minimal API client for the Veltrix platform.
// Authenticates with `Authorization: ApiKey <key>`.
//
// Two entry points:
//   apiRequest — JSON in / JSON out
//   apiUpload  — raw binary body (e.g. application/gzip sync tarballs)
// Both throw ApiError with the HTTP status and the server's {error} message
// (status 0 = the platform could not be reached at all).
// ============================================================================

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

async function send(profile, method, apiPath, { body, headers } = {}) {
  const url = new URL(apiPath, profile.url.endsWith('/') ? profile.url : profile.url + '/')

  let response
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `ApiKey ${profile.apiKey}`,
        ...headers,
      },
      body,
    })
  } catch (e) {
    throw new ApiError(0, `Could not reach ${url.origin} — ${e.cause?.code || e.message}`)
  }

  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }

  if (!response.ok) {
    // The platform reports failures as {error}; Fastify's default 404 for an
    // unknown route uses {message}. Surface whichever exists. A gateway/proxy
    // failure (502/503/504) answers with HTML, so neither key is present —
    // fall back to the status line so the user sees "HTTP 502 Bad Gateway"
    // rather than a bare code.
    const statusLine = response.statusText
      ? `HTTP ${response.status} ${response.statusText}`
      : `HTTP ${response.status}`
    throw new ApiError(response.status, data.error || data.message || statusLine, data)
  }
  return data
}

/** JSON request. `body` (when given) is JSON-serialized. */
export async function apiRequest(profile, method, apiPath, body, extraHeaders = {}) {
  const hasBody = body !== undefined
  return send(profile, method, apiPath, {
    body: hasBody ? JSON.stringify(body) : undefined,
    headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
  })
}

/** Raw binary upload (Buffer body), default Content-Type application/gzip. */
export async function apiUpload(
  profile,
  method,
  apiPath,
  buffer,
  contentType = 'application/gzip',
  extraHeaders = {},
) {
  return send(profile, method, apiPath, {
    body: buffer,
    headers: { 'Content-Type': contentType, ...extraHeaders },
  })
}

/** Verify the API key and return { customerId, type, scopes, ownership }. */
export async function checkAuth(profile) {
  return apiRequest(profile, 'GET', 'api/auth/api-key/check')
}
