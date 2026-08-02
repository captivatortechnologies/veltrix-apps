import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Scan targets']

/**
 * Step-by-step connection guide for Greenbone, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. GMP account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Greenbone, use (or create) a user with permission to manage targets. Greenbone speaks the
              <strong> Greenbone Management Protocol (GMP)</strong> — XML over a TLS socket — and authenticates
              with that user's <strong>username and password</strong> (the same credentials as the web UI). This
              app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>Store the username and password as a Veltrix credential on the <strong>Connections</strong> page.</p>
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
              On <strong>Connections</strong>, add a connection pointing at your gvmd host and attach the GMP
              username/password. GMP is spoken over TLS on port <strong>9390</strong> by default (configurable in
              settings). Use <strong>Test</strong> to open the socket, authenticate, and read the GMP version.
              Saving the connection also registers the Greenbone manager as a deploy target.
            </p>
            <p>
              Note: gvmd commonly ships a self-signed certificate, so TLS verification is off by default. Newer
              Greenbone OS releases prefer an SSH-tunnelled socket over the plain TLS listener — verify the
              transport your appliance exposes.
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
              Open the <strong>Configuration Canvas</strong>, pick the Greenbone <strong>Scan Targets</strong>
              configuration type, author your targets (name, hosts, optional excludes, port list), and deploy
              through the pipeline. Targets upsert by name; drift detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
