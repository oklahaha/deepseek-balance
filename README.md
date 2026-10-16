# deepseek-balance

A Claude Code mod for when Claude Code runs on **DeepSeek**. It draws one line above the prompt:

```
◆ DeepSeek │ ☁ 44k ▅▂█ ▲ +6.3k 34% │ █████████▁ $9.22 of $10.00 left │ $0.78 today │ mostly deepseek-chat 92% │ key $0.22 of $1.00 left
```

From left to right:

| Part | What it shows |
| --- | --- |
| `☁ 44k ▅▂█ ▲ +6.3k 34%` | **Context window.** A sky for how full it is (☀ under 25%, ☁ under 50%, ☂ under 75%, ☇ under 90%, red ↯ = compact soon), the tokens in it, one bar per recent prompt sized by the tokens it added, the last prompt's change, and the share of the window. A compaction shows at once (▼). |
| `█████████▁ $9.22 of $10.00 left` | **Real DeepSeek balance**, read from DeepSeek's `/user/balance`. The yellow gauge is measured against your balance right after your last top-up (or the **Gauge full at** setting). It turns red under 10%. |
| `$0.78 today` | **Today's actual spend** for the whole account: the first balance reading today, plus top-ups since, minus the balance now. |
| `mostly deepseek-chat 92%` | **Where the money went today**: the model with the highest cost, estimated from the tokens each request used, at DeepSeek list prices. |
| `key $0.22 of $1.00 left` | **This API key's own spend** against a limit you set. DeepSeek has no per-key limits, so the mod tracks them itself. |

If DeepSeek won't give the balance for your key, the gauge shows what's left of the key's own limit instead, and today's spend becomes an estimate (`≈`):

```
◆ DeepSeek │ ↯ 118k ▅██ ▲ +7k 92% │ ██▁▁▁▁▁▁▁▁ $0.22 of $1.00 key limit left │ ≈$0.78 today │ mostly deepseek-chat 92%
```

You also get:

- **`/deepseek`** opens a side pane with the full breakdown: balance (topped up and granted), today's spend, context, cost per model, and the key's spend and limit. Press `r` or **Refresh** to read the balance again.
- **`/deepseek refresh`** reads the balance now and prints a one-line summary.
- A pop-up notice, at most once a day, when the balance drops under 10% or the key passes its limit.

## Requirements

- Claude Code **2.1.301 or newer** (mods with hooks modules). Check with `claude --version`.
- Claude Code pointed at DeepSeek's Anthropic-compatible API. For example, in `~/.claude/settings.json`:

  ```json
  {
    "env": {
      "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
      "ANTHROPIC_AUTH_TOKEN": "sk-...your DeepSeek key...",
      "ANTHROPIC_MODEL": "deepseek-chat"
    }
  }
  ```

## Install

At the Claude Code prompt:

```
/plugin install deepseek-balance --marketplace oklahaha/deepseek-balance
```

Answer `y` to add the marketplace, then pick **User** scope so the mod runs in every session. Or from a shell:

```
claude plugin install deepseek-balance --marketplace oklahaha/deepseek-balance
```

The band appears in the session where you installed it, and in every session started after.

## Set up

The mod needs a DeepSeek key to read the balance. It uses the first one it finds:

1. The **DeepSeek API key** setting of the mod.
2. The `DEEPSEEK_API_KEY` environment variable.
3. Claude Code's own `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, **only** when `ANTHROPIC_BASE_URL` points at DeepSeek. An Anthropic key is never sent anywhere else.

With the setup above, step 3 applies and there is nothing to set. To change settings, open `/config` (the mod's rows are under **deepseek-balance**). The API key is secret, so it isn't listed there: set it when you install, or from a shell with `claude plugin configure deepseek-balance`.

| Setting | Default | What it does |
| --- | --- | --- |
| DeepSeek API key | empty | The key to read the balance with. Stored in secure storage. |
| This key's spend limit | `0` (none) | Limit for this key, in the balance currency. |
| Key limit period | `day` | What the limit counts: `day`, `month` or `total`. |
| Gauge full at | `0` (auto) | The balance that fills the gauge. Auto uses the balance right after your last top-up. |
| Context window (tokens) | `0` (auto) | The window the context is measured against. Auto uses Claude Code's figure for the model. Set `128000` to measure against DeepSeek V3.2's real limit. |
| Currency | `auto` | `USD` or `CNY` when the account holds both. |
| Refresh every (seconds) | `120` | How often the balance is read (at least 30). It is also read after each turn. |
| DeepSeek API base | `https://api.deepseek.com` | Where `/user/balance` is read from. |

## Update and uninstall

```
claude plugin update deepseek-balance
claude plugin uninstall deepseek-balance
```

Then run `/reload-plugins` in an open session, or start a new one.

## How the numbers are worked out

- **Balance** is DeepSeek's own figure. Everything else is computed by the mod on your machine.
- **Today** starts at the first balance reading of the day (local time). Spend from before that first reading (for example, another app using the account before you open Claude Code) isn't counted.
- **Model and key costs** are estimates: input tokens (cache hit and miss) and output tokens of each request this Claude Code sends, at DeepSeek's V3.2 list prices ($0.028 / $0.28 / $0.42 per million tokens, or ¥0.2 / ¥2 / ¥3). If DeepSeek changes its prices, update `PRICES` in `hooks/ledger.ts`. The balance and today's spend do not depend on them.
- **Context** uses the figures Claude Code's own status line uses: the last reply's input tokens against the model's window.

## Privacy

- The only network request is `GET <API base>/user/balance`, sent with your DeepSeek key.
- The key itself is never stored by the mod. It keeps a short hash and the last 4 characters (`sk-…ab12`) to tell keys apart.
- Today's figures, per-model costs and per-key spend are kept in the mod's local storage on that machine.

## Troubleshooting

| You see | Do this |
| --- | --- |
| `no API key (set DEEPSEEK_API_KEY or /config)` | Set the **DeepSeek API key** setting, or `DEEPSEEK_API_KEY`, or point `ANTHROPIC_BASE_URL` at DeepSeek. |
| `key rejected (401)` | The key is wrong or revoked. The key's own spend and limit still show. |
| `balance unavailable (…)` | DeepSeek did not return a balance for this key. Spend shows as an estimate (`≈`). |
| `balance unreachable` | No network to `api.deepseek.com` from this machine, or a proxy blocks it. |
| No band at all | Check `claude --version` (2.1.301+), that the mod is enabled in `/plugin`, then `/reload-plugins`. |
| The context share looks low | Claude Code may assume a larger window than DeepSeek's. Set **Context window** to `128000`. |

## Develop

```
git clone https://github.com/oklahaha/deepseek-balance
cd deepseek-balance
claude plugin validate .
claude plugin test .
claude --plugin-dir .     # one session with your working copy loaded
```

| File | What it holds |
| --- | --- |
| `hooks/register.tsx` | The hooks: reading the balance, tracking usage, the band, the pane, `/deepseek`. |
| `hooks/ledger.ts` | Balance, today's spend, per-model and per-key costs, prices, the summary line. Pure functions. |
| `hooks/context.ts` | The context weather: sky, per-prompt bars, trend. Pure functions. |
| `types/index.d.ts` | The shapes the band and pane draw from. |
| `tests/` | `claude plugin test` suites: the pure logic, and the mod end to end with DeepSeek mocked. |

Guidelines for changes:

- Keep the math in `ledger.ts` and `context.ts` as pure functions, and test it in `tests/ledger.test.ts`.
- Mock every outside call in tests (`http.fetch`, `session.usage`, the store, the clock). Tests never call DeepSeek.
- Never send a key anywhere but the configured DeepSeek API base, and never store a key in the mod's storage.
- Run `claude plugin validate .` and `claude plugin test .` before each commit.
- Bump `version` in `.claude-plugin/plugin.json` for each release, so `claude plugin update` picks it up.

## Credits

The context weather (sky, per-prompt bars, trend) follows the idea of Anthropic's **Token Weather** example and the **token-weather-usage** mod by Eric Cologni (Apache-2.0). No code is copied.
