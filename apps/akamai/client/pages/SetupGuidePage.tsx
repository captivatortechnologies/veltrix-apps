import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Network Lists']

/**
 * Step-by-step connection guide for Akamai, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. EdgeGrid credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In <strong>Akamai Control Center → Identity &amp; access</strong>, create an API client
              with authorization for the <strong>Network Lists</strong> API. Download its{' '}
              <code>.edgerc</code> — it contains four values: <code>host</code>,{' '}
              <code>client_token</code>, <code>client_secret</code> and <code>access_token</code>.
              This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the EdgeGrid values as a Veltrix credential on the <strong>Connections</strong>{' '}
              page: <code>client_token</code> as the username, <code>access_token</code> as the API
              token, and <code>client_secret</code> as the password. The <code>host</code> is the
              connection endpoint.
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
              On <strong>Connections</strong>, add a connection pointing at your Akamai API{' '}
              <code>host</code> (the HTTPS host from the <code>.edgerc</code>) and attach the EdgeGrid
              credential. Use <strong>Test</strong> to verify the API is reachable and the EdgeGrid
              signature authenticates (GET <code>/network-list/v2/network-lists</code>). Saving the
              connection also registers the Akamai host as a deploy target.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'author',
      label: '3. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Open the <strong>Configuration Canvas</strong>, pick the Akamai{' '}
              <strong>Network Lists</strong> configuration type, author your lists (name, type,
              description, elements), and deploy through the pipeline. Drift detection and rollback
              are handled per type.
            </p>
            <p>
              Activating a list to STAGING / PRODUCTION is a separate Akamai step and is out of scope
              for this version — the app manages list content only.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
