import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Resources']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'api-key',
      label: '1. API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Twingate Admin Console, go to <strong>Settings &gt; API</strong> and select{' '}
              <strong>Generate Token</strong>. This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Twingate shows the generated key once — copy it. It is sent as the <code>X-API-KEY</code>{' '}
              header on every request; there is no token exchange or expiry to manage.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: '2. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Add a connection on the <strong>Connections</strong> page: set the endpoint to your Twingate
              network name (e.g. <code>acme</code> or <code>acme.twingate.com</code>) and paste the
              generated key into <strong>API token</strong>. Saving the connection also registers the
              deploy-target component the Resources config type targets.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'prerequisites',
      label: '3. Prerequisites',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Before deploying Resources, create the <strong>Remote Network</strong> (and at least one
              online <strong>Connector</strong>) it belongs to, and any <strong>Groups</strong> you plan to
              grant access to, directly in Twingate. The Resources config type resolves both by name at
              deploy time — it does not create Remote Networks, Connectors or Groups.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
