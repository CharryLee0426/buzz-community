import { Center } from '@astryxdesign/core/Center'
import { Spinner } from '@astryxdesign/core/Spinner'

/** Fills its region while something that replaces the whole region loads. */
export function PageSpinner({ label }: { label: string }) {
  return (
    <Center axis="both" height="100%">
      <Spinner size="lg" aria-label={label} />
    </Center>
  )
}
