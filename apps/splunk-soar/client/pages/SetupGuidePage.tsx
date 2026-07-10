import React from 'react'
import { Badge, Button, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const SETTINGS = ['verify_ssl', 'request_timeout_seconds', 'max_retries']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge /
 * Button the built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'component',
      label: '1. Instance',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Add a component of type <code>soar-instance</code>. Set its hostname to your Splunk
              SOAR host (for example <code>soar.example.com</code>). SOAR serves its REST API over
              HTTPS on the web port — leave the port at <code>443</code> unless your deployment
              uses a custom one.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'api-token',
      label: '2. API token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the SOAR console, create (or reuse) an <strong>automation user</strong> and copy
              its <strong>automation API token</strong> from{' '}
              <strong>User Settings &gt; API Access</strong> (the token acts as the{' '}
              <code>ph-auth-token</code> header on every REST call).
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                window.open('https://docs.splunk.com/Documentation/SOAR', '_blank', 'noopener')
              }
            >
              Open Splunk SOAR docs
            </Button>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '3. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Create a credential attached to the component's tool and put the automation{' '}
              <strong>API token</strong> in the <em>API token</em> field. If your instance only
              allows Basic auth, use the <em>username</em> and <em>password</em> fields instead.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'deploy',
      label: '4. Connect & verify',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Create a <strong>SOAR Connection</strong> configuration in the Configuration Canvas
              (name and describe it) and run it through the pipeline. Deploy verifies reachability
              (<code>GET /rest/version</code>); health check and drift detection keep confirming
              the platform can reach SOAR. Tune behaviour with the app settings:
            </p>
            <div>
              {SETTINGS.map((setting) => (
                <Badge key={setting} variant="primary" size="sm">
                  {setting}
                </Badge>
              ))}
            </div>
          </CardBody>
        </Card>
      ),
    },
  ]

  return (
    <div>
      <h2>Splunk SOAR — Setup Guide</h2>
      <Tabs tabs={tabs} />
    </div>
  )
}
