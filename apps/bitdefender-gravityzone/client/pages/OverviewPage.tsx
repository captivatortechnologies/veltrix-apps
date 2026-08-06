import React, { useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import { Badge, Card, CardBody, EmptyState, Spinner } from '@veltrixsecops/app-sdk/ui'

interface ConfigTypeSummary {
  id: string
  name: string
  description?: string
  componentTypes: string[]
}

interface AppMeta {
  appId: string
  name: string
  version: string
  configurationTypes: ConfigTypeSummary[]
}

/**
 * Shows what this app manages in a GravityZone Control Center tenant, using
 * the platform design-system components from @veltrixsecops/app-sdk/ui — so
 * the page matches the platform look and picks up the app's brand color.
 * Authoring happens in the platform's Configuration Canvas.
 */
export default function OverviewPage() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch('/api/apps/bitdefender-gravityzone/meta')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setMeta)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner label="Loading Bitdefender GravityZone app details…" />
  if (error) {
    return <EmptyState title="Failed to load app details" description={error} />
  }
  if (!meta) return <EmptyState title="No app details available" />

  return (
    <Card>
      <CardBody>
        <p>
          Manages Bitdefender GravityZone endpoint security configuration as code through the GravityZone
          Control Center Public API — a JSON-RPC 2.0 API (not REST), authenticated with a single API key over
          HTTP Basic. Create a configuration in the Configuration Canvas and deploy it through the pipeline —
          validate, deploy, health check, drift detection and rollback are all handled per configuration type.
          GravityZone's Policies service is overwhelmingly list/read-only — full policy authoring happens only
          in the Control Center console; see the Setup Guide for what this app can and cannot manage.
        </p>

        <h3>Configuration Types</h3>
        {meta.configurationTypes.map((ct) => (
          <Card key={ct.id} variant="bordered" padding="md">
            <CardBody>
              <strong>{ct.name}</strong>
              {ct.description ? <p>{ct.description}</p> : null}
              <div>
                {ct.componentTypes.map((type) => (
                  <Badge key={type} variant="secondary" size="sm">
                    {type}
                  </Badge>
                ))}
              </div>
            </CardBody>
          </Card>
        ))}
      </CardBody>
    </Card>
  )
}
