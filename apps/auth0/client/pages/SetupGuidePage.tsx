import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Applications (Clients)']

/**
 * Step-by-step connection guide for Auth0, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. M2M application',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Auth0, go to <strong>Applications → Applications</strong> and create a
              <strong> Machine to Machine</strong> application authorized for the
              <strong> Auth0 Management API</strong>. Grant it the client scopes this app manages:
            </p>
            <div>
              {['read:clients', 'create:clients', 'update:clients', 'delete:clients'].map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              This app manages:{' '}
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="secondary" size="sm">
                  {scope}
                </Badge>
              ))}
              . Copy the M2M application's <strong>Client ID</strong> and <strong>Client Secret</strong>.
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
              On <strong>Connections</strong>, add a connection pointing at your Auth0 tenant domain (e.g.
              <code> acme.us.auth0.com</code>) and attach the Machine-to-Machine{' '}
              <strong>Client ID</strong> and <strong>Client Secret</strong>. Use <strong>Test</strong> to
              verify the token mints (client-credentials grant) and the Management API answers (GET{' '}
              <code>/api/v2/clients</code>). Saving the connection also registers the Auth0 tenant as a deploy
              target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Auth0{' '}
              <strong>Applications (Clients)</strong> configuration type, author your applications (name,
              application type, callback / logout / web-origin URLs, token endpoint auth method), and deploy
              through the pipeline. Applications are upserted by name; drift detection and rollback are
              handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
