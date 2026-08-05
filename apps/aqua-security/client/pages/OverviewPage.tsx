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
 * What this app manages in Aqua Security, rendered with the platform
 * design-system components. Authoring happens in the Configuration Canvas.
 */
export default function OverviewPage() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch('/api/apps/aqua-security/meta')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setMeta)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner label="Loading Aqua Security app details…" />
  if (error) return <EmptyState title="Failed to load app details" description={error} />
  if (!meta) return <EmptyState title="No app details available" />

  return (
    <Card>
      <CardBody>
        <p>
          Manages Aqua Security (CNAPP) as code — image, host, function and Kubernetes assurance policies,
          container and host runtime policies, firewall policies, application scopes and Enforcer Group
          protection configuration. Author each in the Configuration Canvas and deploy through the
          pipeline — validate, deploy, health check, drift detection and rollback are handled per
          configuration type. Applied over the Aqua CSP/Enterprise Console REST API with a dedicated Aqua
          user (session-token auth).
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
