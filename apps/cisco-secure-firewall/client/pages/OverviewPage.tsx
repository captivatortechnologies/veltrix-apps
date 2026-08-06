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
 * Shows what this app manages on an FMC instance, using the platform
 * design-system components from @veltrixsecops/app-sdk/ui - so the page
 * matches the platform look and picks up the app's brand color. Authoring
 * happens in the platform's Configuration Canvas.
 */
export default function OverviewPage() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch('/api/apps/cisco-secure-firewall/meta')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setMeta)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner label="Loading Cisco Secure Firewall app details..." />
  if (error) {
    return <EmptyState title="Failed to load app details" description={error} />
  }
  if (!meta) return <EmptyState title="No app details available" />

  return (
    <Card>
      <CardBody>
        <p>
          Manages Cisco Secure Firewall Management Center (FMC) configuration as code through the FMC
          REST API - access control policies &amp; rules, network/port/URL objects &amp; groups, and
          security zones. Create a configuration in the Configuration Canvas and deploy it through the
          pipeline - validate, deploy, health check, drift detection, and rollback are all handled per
          configuration type. Deploying to managed firewalls is a separate, opt-in activation step (see
          the Setup Guide) - not something authored here.
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
