// ============================================================================
// Minimal API client for the Veltrix platform.
// Authenticates with `Authorization: ApiKey <key>`.
// ============================================================================

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export async function apiRequest(profile, method, apiPath, body) {
  const url = new URL(apiPath, profile.url.endsWith('/') ? profile.url : profile.url + '/')

  let response
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `ApiKey ${profile.apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
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
    throw new ApiError(response.status, data.error || `HTTP ${response.status}`)
  }
  return data
}

/** Verify the API key and return { customerId, type, scopes, ownership }. */
export async function checkAuth(profile) {
  return apiRequest(profile, 'GET', 'api/auth/api-key/check')
}
