import type { ContextView } from '../types'

// The context's weather, after the Token Weather idea (see the README's credits):
// a sky by how full the window is, one bar per recent prompt, the last prompt's change.

/** Token readings kept for the bars: one more than the bars drawn. */
const HISTORY = 6
const BARS = '▁▂▃▄▅▆▇█'

export type Weather = { word: string; icon: string; color: string }

const SKIES: { below: number; weather: Weather }[] = [
  { below: 25, weather: { word: 'clear', icon: '☀', color: '#e0b000' } },
  { below: 50, weather: { word: 'cloudy', icon: '☁', color: '#1ba1c4' } },
  { below: 75, weather: { word: 'showers', icon: '☂', color: '#2f68c0' } },
  { below: 90, weather: { word: 'storm', icon: '☇', color: '#b04fc0' } },
  { below: Infinity, weather: { word: 'compact soon', icon: '↯', color: 'error' } },
]

export const weatherOf = (percent: number): Weather =>
  (SKIES.find(sky => percent < sky.below) ?? SKIES[SKIES.length - 1]!).weather

/** 950, 6.3k, 98.3k, 128k, 1.2M: a decimal only where it says something. */
export const tokensShort = (n: number) => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 100_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

/**
 * Adds Claude Code's latest reading to the history. The window is Claude Code's,
 * or the one set in the options; a repeated reading adds nothing.
 */
export const pushReading = (
  held: ContextView | null,
  tokens: number | undefined,
  window: number,
  override: number,
): ContextView => {
  const size = override > 0 ? override : window
  const history = (held?.history ?? []).filter(n => n > 0)
  if (tokens !== undefined && tokens > 0 && history[history.length - 1] !== tokens) {
    history.push(tokens)
  }
  const now = tokens ?? null
  return {
    tokens: now,
    window: size,
    percent: now === null || size <= 0 ? null : Math.round((now / size) * 100),
    history: history.slice(-HISTORY),
  }
}

/** Tokens each recent prompt added, oldest first; a compaction counts as 0. */
export const turnDeltas = (history: readonly number[]) =>
  history.slice(1).map((tokens, i) => Math.max(0, tokens - history[i]!))

/** One glyph per prompt, scaled to the heaviest one shown. */
export const turnBars = (history: readonly number[]) => {
  const deltas = turnDeltas(history)
  const top = Math.max(...deltas, 1)
  return deltas.map(d => BARS[Math.round((d / top) * (BARS.length - 1))]!).join('')
}

/** The last prompt's change: ▲ +6.3k, ▼ −120k, or = when it held. */
export const trendOf = (history: readonly number[]) => {
  if (history.length < 2) return ''
  const delta = history[history.length - 1]! - history[history.length - 2]!
  if (delta > 0) return `▲ +${tokensShort(delta)}`
  if (delta < 0) return `▼ −${tokensShort(-delta)}`
  return '='
}

/** The context as one line of text: `☂ 44k ▃▄▂█▆ ▲ +6.3k 34%`. */
export const contextLine = (ctx: ContextView) => {
  if (ctx.tokens === null || ctx.percent === null) return ''
  const parts = [`${weatherOf(ctx.percent).icon} ${tokensShort(ctx.tokens)}`]
  if (ctx.history.length >= 2) parts.push(turnBars(ctx.history), trendOf(ctx.history))
  parts.push(`${ctx.percent}%`)
  return parts.join(' ')
}
