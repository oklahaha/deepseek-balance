import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = new Date(2026, 9, 16, 9, 0).getTime()

const balanceBody = (total: string) =>
  JSON.stringify({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: total, granted_balance: '0.00', topped_up_balance: total },
    ],
  })

function world(
  on: On,
  env: Record<string, string>,
  answers: { status: number; text: string }[],
  window: { tokens: number | undefined; window: number } | number[] = { tokens: 44_000, window: 128_000 },
) {
  mock.env(on, env)
  mock.store(on)
  const clock = mock.clock(on, { now: T0 })
  const calls: { url: string; auth: string }[] = []
  on('settings.read', () => ({ value: {} }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  let reading = 0
  on('session.usage', () => {
    const now = Array.isArray(window)
      ? { tokens: window[Math.min(reading++, window.length - 1)], window: 128_000 }
      : window
    return {
      value: {
        startedAt: T0,
        context: {
          ...now,
          percent: now.tokens === undefined ? undefined : Math.round((now.tokens / now.window) * 100),
        },
        rateLimits: [],
      },
    }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn' as const,
      usage: {
        model: 'deepseek-chat', input_tokens: 1_000_000, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      },
    }
  })
  on('http.fetch', (_$, e) => {
    calls.push({ url: e.url, auth: e.init?.headers?.Authorization ?? '' })
    const a = answers[Math.min(calls.length - 1, answers.length - 1)] ?? { status: 500, text: '' }
    return { value: { status: a.status, ok: a.status < 300, headers: {}, text: a.text } }
  })
  return { calls, clock }
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, bodyColumns: 120 } as never,
} as const

async function refreshText($: Engine) {
  const ran = await $.command.run({
    command: 'deepseek', args: 'refresh', origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 120 },
  } as never)
  return (ran as { text: string }).text
}

const DEEPSEEK_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'sk-test-0000ab12',
}

test('reads the balance with the key Claude Code sends to DeepSeek', async ($, on) => {
  const { calls, clock } = world(on, DEEPSEEK_ENV, [
    { status: 200, text: balanceBody('10.00') },
    { status: 200, text: balanceBody('9.60') },
  ])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const step = $.turn.step({ turnId: 't', index: 0, model: 'deepseek-chat', messageCount: 1 })
  for await (const _ of step) void _
  await step.result

  const ran = await $.command.run({
    command: 'deepseek', args: 'refresh', origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 120 },
  } as never)
  expect(calls[0]).toEqual({
    url: 'https://api.deepseek.com/user/balance', auth: 'Bearer sk-test-0000ab12',
  })
  expect((ran as { text: string }).text).toBe(
    'DeepSeek │ ☁ 44k 34% │ $9.60 ▰▰▰▰▰▰▰▰▰▰ 96% │ today $0.40 │ mostly deepseek-chat 100% │ key sk-…ab12 $0.28',
  )
})

test('never sends an Anthropic key anywhere but DeepSeek', async ($, on) => {
  const { calls, clock } = world(
    on,
    { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: 'sk-ant-secret' },
    [],
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(calls.length).toBe(0)
  expect(await refreshText($)).toMatch('│ no API key (set DEEPSEEK_API_KEY or /config)')
})

test('a key the balance endpoint refuses still shows its own spend and limit', { options: { keyLimit: 2, apiKey: 'sk-limited-zz99' } }, async ($, on) => {
  const { clock } = world(on, {}, [{ status: 401, text: '{"error":{"message":"Authentication Fails"}}' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(await refreshText($)).toBe('DeepSeek │ ☁ 44k 34% │ key rejected (401) │ key sk-…zz99 $0.00/$2.00 day')
  const band = await $.ui.mount({ plugin: 'deepseek-balance', surface: 'terminal', ...BAND })
  // no balance from DeepSeek: the gauge shows what is left of the key's own limit
  expect(await band.find({ text: /\$2\.00 of \$2\.00 key limit left/ })).toBeDefined()
  await band.unmount()
})

test('the pane draws balance, gauge, today, models and the key on each surface', { options: { keyLimit: 1 } }, async ($, on) => {
  const { calls, clock } = world(on, DEEPSEEK_ENV, [
    { status: 200, text: balanceBody('10.00') },
    { status: 200, text: balanceBody('9.60') },
  ])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const step = $.turn.step({ turnId: 't', index: 0, model: 'deepseek-chat', messageCount: 1 })
  for await (const _ of step) void _
  await step.result
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'deepseek-balance',
      surface,
      component: 'Pane',
      requestId: 'deepseek-balance',
      props: { title: 'DeepSeek balance', isFocused: true, bodyColumns: 60, placement: 'dock' } as never,
    })
    expect(await ui.find({ text: /Balance/ })).toBeDefined()
    expect(await ui.find({ text: /deepseek-chat/ })).toBeDefined()
    expect(await ui.find({ text: /sk-…ab12/ })).toBeDefined()
    expect(await ui.find({ text: /of \$1\.00 limit/ })).toBeDefined()
    const before = calls.length
    await ui.press({ key: 'refresh' })
    expect(calls.length).toBe(before + 1)
    expect(await ui.find({ text: /\$0\.40 spent/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the band shows the gauge, what is left, today and the top model', { options: { keyLimit: 1 } }, async ($, on) => {
  const { clock } = world(on, DEEPSEEK_ENV, [
    { status: 200, text: balanceBody('10.00') },
    { status: 200, text: balanceBody('9.60') },
  ])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const step = $.turn.step({ turnId: 't', index: 0, model: 'deepseek-chat', messageCount: 1 })
  for await (const _ of step) void _
  await step.result
  await refreshText($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'deepseek-balance', surface, ...BAND })
    const text = (await band.find({ text: /DeepSeek/ }))?.text ?? ''
    expect(text).toBe(
      `◆ DeepSeek │ ☁ 44k 34% │ ${' '.repeat(10)} $9.60 of $10.00 left │ $0.40 today │ mostly deepseek-chat 100% │ key $0.72 of $1.00 left`,
    )
    // the gauge is a solid yellow block, as on the OpenRouter line
    const drawn = JSON.stringify(await band.drawn())
    expect(drawn).toMatch('"backgroundColor":"#fbd800"},"children":["          "]')
    expect(drawn).toMatch('"color":"#869cff"')
    // the context's weather: cloudy at 34%
    expect(drawn).toMatch(/"color":"#1ba1c4","bold":true[^}]*},"children":\["☁"\]/)
    await band.unmount()
  }
})

test('the context gauge measures against the window set in the options and warns near full', { options: { contextWindow: 100_000 } }, async ($, on) => {
  const { clock } = world(on, DEEPSEEK_ENV, [{ status: 200, text: balanceBody('5.00') }], {
    tokens: 90_000,
    window: 200_000,
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(await refreshText($)).toMatch('DeepSeek │ ↯ 90k 90% │ $5.00')
  const band = await $.ui.mount({ plugin: 'deepseek-balance', surface: 'terminal', ...BAND })
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toMatch(/"color":"error","bold":true[^}]*},"children":\["↯"\]/)
  await band.unmount()
})

test('a fresh session shows no context gauge until the first reply', async ($, on) => {
  const { clock } = world(on, DEEPSEEK_ENV, [{ status: 200, text: balanceBody('5.00') }], {
    tokens: undefined,
    window: 128_000,
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(await refreshText($)).toMatch(/^DeepSeek │ \$5\.00/)
  const band = await $.ui.mount({ plugin: 'deepseek-balance', surface: 'terminal', ...BAND })
  expect(await band.find({ text: /ctx/ })).toBe(undefined)
  await band.unmount()
})

test('the context shows a bar per recent prompt and the last change, and drops on compaction', async ($, on) => {
  const { clock } = world(on, DEEPSEEK_ENV, [{ status: 200, text: balanceBody('5.00') }], [
    10_000, 16_000, 40_000, 46_300,
  ])
  const summary = [{ role: 'user', text: 'Summary of the conversation so far', toolUses: [] }] as never
  on('session.compact', () => ({ messages: summary, tokensBefore: 46_300, tokensAfter: 12_000 }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (let i = 0; i < 3; i++) {
    const step = $.turn.step({ turnId: 't', index: i, model: 'deepseek-chat', messageCount: 1 })
    for await (const _ of step) void _
    await step.result
  }
  const band = await $.ui.mount({ plugin: 'deepseek-balance', surface: 'terminal', ...BAND })
  expect((await band.find({ text: /☁/ }))?.text).toMatch('☁ 46.3k ▃█▃ ▲ +6.3k 36%')
  await band.unmount()

  await $.session.compact({ trigger: 'manual', messages: summary })
  const after = await $.ui.mount({ plugin: 'deepseek-balance', surface: 'terminal', ...BAND })
  expect((await after.find({ text: /☀/ }))?.text).toMatch('☀ 12k ▃█▃▁ ▼ −34.3k 9%')
  await after.unmount()
})
