import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'sysdig-secure',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/sysdig-secure/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/sysdig-secure/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/sysdig-secure/connections', label: 'Connections', icon: 'link' },
  ],
}
