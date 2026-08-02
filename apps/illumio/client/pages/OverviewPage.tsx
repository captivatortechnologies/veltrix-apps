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
 * Shows what this app manages in the Illumio PCE, using the platform
 * design-system components from @veltrixsecops/app-sdk/ui — so the page
 * matches the platform look and picks up the app's brand color. Authoring/
 * editing happens in the platform's Configuration Canvas.
 */
export default function OverviewPage() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch('/api/apps/illumio/meta')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setMeta)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner label="Loading Illumio app details…" />
  if (error) {
    return <EmptyState title="Failed to load app details" description={error} />
  }
  if (!meta) return <EmptyState title="No app details available" />

  return (
    <Card>
      <CardBody>
        <p>
          Manages Illumio Core (Policy Compute Engine) microsegmentation configuration as code through the
          Illumio REST API v2. Create a configuration in the Configuration Canvas and deploy it through the
          pipeline — validate, deploy, health check, drift detection, and rollback are all handled per
          configuration type. Labels are matched by their (key, value) pair; IP lists, services and rulesets are
          matched by name, upserted where missing, and reconciled where this app's own prior creations are
          removed from the canvas.
        </p>
        <p>
          IP lists, services and rulesets use the PCE's <strong>draft-then-provision</strong> model: every write
          lands in the draft policy first, then this app provisions the changed hrefs into a new active policy
          version in the same deploy. Ruleset rules reference labels, IP lists and services by name — every
          reference is resolved to the PCE's internal id and the whole ruleset fails closed (nothing is applied)
          if any reference can't be resolved.
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
