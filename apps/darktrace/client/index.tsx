import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'darktrace',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/darktrace/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/darktrace/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/darktrace/connections', label: 'Connections', icon: 'link' },
  ],
}
