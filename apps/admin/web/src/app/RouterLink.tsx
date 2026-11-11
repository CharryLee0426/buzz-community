import type { AnchorHTMLAttributes, Ref } from 'react'
import { Link } from 'react-router'

type RouterLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href?: string
  to?: string
  ref?: Ref<HTMLAnchorElement>
}

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/**
 * The link component Astryx renders through LinkProvider. In-app paths go to
 * the client router; anything with a scheme stays a plain anchor so the
 * browser handles it.
 */
export function RouterLink({ href, to, ref, ...rest }: RouterLinkProps) {
  const target = to ?? href
  if (target === undefined || ABSOLUTE_URL.test(target) || target.startsWith('#')) {
    return <a ref={ref} href={target} {...rest} />
  }
  return <Link ref={ref} to={target} {...rest} />
}
