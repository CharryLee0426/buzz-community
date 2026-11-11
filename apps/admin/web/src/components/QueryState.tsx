import { useEffect, type ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { useAnnounce } from '@astryxdesign/core/hooks'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { VStack } from '@astryxdesign/core/Stack'
import { describeError } from '../lib/errors'

function LoadingRows({ rows }: { rows: number }) {
  const announce = useAnnounce()
  useEffect(() => announce('Loading'), [announce])
  return (
    <VStack gap={2} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={36} index={index} />
      ))}
    </VStack>
  )
}

interface QueryStateProps<T> {
  query: UseQueryResult<T>
  /** Rows of placeholder shown while the first load is in flight. */
  skeletonRows?: number
  children: (data: T) => ReactNode
}

/**
 * Renders a query's data, or the state that stands in for it: a placeholder
 * while it first loads, and a named problem with a way forward when it fails.
 * When a later refresh fails, the last good data stays, marked as out of date.
 */
export function QueryState<T>({ query, skeletonRows = 6, children }: QueryStateProps<T>) {
  const retry = <Button label="Retry" variant="secondary" size="sm" isLoading={query.isFetching} onClick={() => query.refetch()} />

  if (query.data !== undefined) {
    if (!query.isError) return <>{children(query.data)}</>
    return (
      <VStack gap={4}>
        <Banner
          status="warning"
          title="This view is out of date"
          description={`The last refresh failed. ${describeError(query.error).description}`}
          endContent={retry}
        />
        {children(query.data)}
      </VStack>
    )
  }
  if (query.isPending) return <LoadingRows rows={skeletonRows} />

  const problem = describeError(query.error)
  return (
    <EmptyState
      title={problem.title}
      description={problem.description}
      actions={problem.action ? <Button label={problem.action.label} href={problem.action.href} variant="secondary" /> : retry}
    />
  )
}
