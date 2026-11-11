import { Component, type ReactNode } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Center } from '@astryxdesign/core/Center'
import { EmptyState } from '@astryxdesign/core/EmptyState'

interface Props {
  /** Changes when the route does, which clears a failure so navigating away recovers. */
  resetKey: string
  children: ReactNode
}

/**
 * Catches a page that fails to load or render, so the navigation stays usable.
 * The usual cause is a deploy: the tab asks for a script the new build no
 * longer has, and a reload picks up the new one.
 */
export class RouteErrorBoundary extends Component<Props, { failedKey: string | null }> {
  override state = { failedKey: null as string | null }

  static getDerivedStateFromError() {
    return { failedKey: '' }
  }

  static getDerivedStateFromProps(props: Props, state: { failedKey: string | null }) {
    if (state.failedKey === '') return { failedKey: props.resetKey }
    if (state.failedKey !== null && state.failedKey !== props.resetKey) return { failedKey: null }
    return null
  }

  override render() {
    if (this.state.failedKey === null) return this.props.children
    return (
      <Center axis="both" height="100%" padding={6}>
        <EmptyState
          headingLevel={1}
          title="This page failed to load"
          description="The console may have been updated while this tab was open. Reloading fetches the current version."
          actions={<Button label="Reload" variant="primary" onClick={() => window.location.reload()} />}
        />
      </Center>
    )
  }
}
