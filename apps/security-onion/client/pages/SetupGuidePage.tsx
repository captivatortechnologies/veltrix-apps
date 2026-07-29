import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Suricata rules', 'Firewall access', 'SOC users', 'Detections', 'Elastic ILM', 'Zeek']

/**
 * Step-by-step connection guide for Security Onion, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. SOC credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Security Onion Console (SOC), create (or reuse) an admin-capable user for Veltrix. This
              app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the username + password as a Veltrix credential on the <strong>Connections</strong> page.
              The connection endpoint is your <strong>manager's HTTPS host</strong> (the SOC console on 443).
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
              On <strong>Connections</strong>, add a connection pointing at the manager host and attach the
              credential. Use <strong>Test</strong> to verify the SOC console is reachable and the
              credential authenticates. Saving the connection also registers the manager as a deploy target.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'managed-ztna',
      label: '3. Managed connectivity',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Suricata rules, firewall access, SOC users and Zeek are applied on the manager via Salt / the
              <code> so-*</code> CLI, which the platform runs over <strong>managed ZTNA</strong>
              (Tailscale SSH) using the app's allow-listed remote commands. Attach the manager over managed
              connectivity so these operations can run. Detections and Elasticsearch ILM go over the SOC /
              Elasticsearch REST APIs and need only the connection above.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'author',
      label: '4. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Open the <strong>Configuration Canvas</strong>, pick a Security Onion configuration type, author
              your items, and deploy through the pipeline. Drift detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
