import type { ReactNode } from 'react'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { VStack } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'

interface StatProps {
  label: string
  /** The figure, already formatted. `null` while loading, `undefined` when it cannot be known. */
  value: string | null | undefined
  /** A second fact that qualifies the figure, such as its window or a breakdown. */
  detail?: ReactNode
}

/** A headline figure with its label. Laid out in a Grid; carries no container of its own. */
export function Stat({ label, value, detail }: StatProps) {
  return (
    <VStack gap={1}>
      <Text type="label" color="secondary">
        {label}
      </Text>
      {value === null ? (
        <Skeleton width={72} height={32} />
      ) : (
        <Text type="display-3" hasTabularNumbers color={value === undefined ? 'disabled' : 'primary'}>
          {value ?? '—'}
        </Text>
      )}
      {detail ? <Text type="supporting">{detail}</Text> : null}
    </VStack>
  )
}
