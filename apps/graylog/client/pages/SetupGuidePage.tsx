import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Streams']

/**
 * Step-by-step connection guide for Graylog, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Graylog authenticates over its REST API with HTTP Basic. Use either a Graylog{' '}
              <strong>user</strong> (username + password) or — recommended — an <strong>access token</strong>.
              Create a token in Graylog under <strong>System → Users →</strong> your user{' '}
              <strong>→ Edit tokens</strong>. This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the token (or user + password) as a Veltrix credential on the{' '}
              <strong>Connections</strong> page. An access token is sent as the username with the literal
              password <code>token</code>.
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
              On <strong>Connections</strong>, add a connection pointing at your Graylog node (its REST API
              address — the default port is 9000; include a scheme for a non-default setup) and attach the
              credential. Use <strong>Test</strong> to verify Graylog is reachable and the credential
              authenticates (GET <code>/api/system</code>). Saving the connection also registers the Graylog
              node as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Graylog <strong>Streams</strong>
              configuration type, author your streams (title, description, matching type, rules), and deploy
              through the pipeline. Every write carries the required <code>X-Requested-By</code> CSRF header.
              Drift detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
