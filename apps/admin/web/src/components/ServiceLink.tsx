import { Link } from '@astryxdesign/core/Link'

/** A service's name, linking to its logs: the usual next question about a service. */
export function ServiceLink({ name }: { name: string }) {
  return (
    <Link href={`/logs?service=${encodeURIComponent(name)}`} color="primary" weight="medium" tooltip="Open this service’s logs">
      {name}
    </Link>
  )
}
