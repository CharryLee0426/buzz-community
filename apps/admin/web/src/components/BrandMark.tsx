import type { SVGProps } from 'react'

/**
 * The console's mark: one honeycomb cell holding a node. Passed to Astryx
 * `Icon` so it takes the surrounding size and color like any other glyph.
 */
export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" {...props}>
      <path d="M12 2.75 20 7.4v9.2l-8 4.65-8-4.65V7.4z" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
