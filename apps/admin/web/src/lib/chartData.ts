// Series colors come from the theme's data-visualization tokens, in a fixed
// order, so the same service keeps one color on every chart of a page.
export const SERIES_COLORS = [
  'var(--color-data-categorical-blue)',
  'var(--color-data-categorical-orange)',
  'var(--color-data-categorical-purple)',
  'var(--color-data-categorical-teal)',
  'var(--color-data-categorical-pink)',
  'var(--color-data-categorical-green)',
  'var(--color-data-categorical-brown)',
  'var(--color-data-categorical-indigo)',
  'var(--color-data-categorical-cyan)',
  'var(--color-data-categorical-red)',
]

export interface ChartSeries {
  key: string
  name: string
  color: string
}

/** One row per timestamp (`at`, epoch ms) with a value per series key. */
export type ChartRow = { at: number } & Record<string, number | null>

/** Railway reports epoch seconds, the console's own samples are ISO strings; charts want milliseconds. */
export function toMillis(at: number | string): number {
  if (typeof at === 'string') return Date.parse(at)
  return at < 1e12 ? at * 1000 : at
}

/** Merges per-series point lists into one row per timestamp for a chart. */
export function toRows(lists: { key: string; points: { at: number | string; value: number }[] }[]): ChartRow[] {
  const byTime = new Map<number, ChartRow>()
  for (const { key, points } of lists) {
    for (const point of points) {
      const at = toMillis(point.at)
      const row: ChartRow = byTime.get(at) ?? { at }
      row[key] = point.value
      byTime.set(at, row)
    }
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at)
}
