# opencode-cost-tracker

An [opencode](https://opencode.ai) plugin that shows a toast after each assistant turn with:

- the running cost of the current prompt, accumulating as the prompt's steps complete
- the running cost of the whole session
- the model OpenRouter's auto router actually routed to

Built for `openrouter/auto`, where opencode reports `$0.00` because the auto
router has no fixed price in models.dev. It reads the real `usage.cost` and the
routed `model` straight from OpenRouter's response.

## Requirements

- opencode with the built-in OpenRouter provider authenticated
  (`opencode auth login` → OpenRouter, or `OPENROUTER_API_KEY` set).

## Install

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/Upgwades/opencode-cost-tracker/main/cost-tracker.ts \
  -o ~/.config/opencode/plugins/cost-tracker.ts
```

Restart opencode. After your next turn you'll see the session total and the
current prompt's total, both growing as turns complete:

```
$1.2345 session · $0.000013 prompt · deepseek/deepseek-v4-flash-0731
```

For a single project instead of every project, drop the file in
`<project>/.opencode/plugins/` instead.

## How it works

- **Routed model + exact cost** — the plugin injects a wrapping `fetch` into the
  OpenRouter provider (via the plugin `config` hook) and clones each
  `/chat/completions` response, pulling `model` and `usage.cost` from the SSE
  stream or JSON body. opencode itself discards both.
- **Fallback cost** — if a response can't be observed, it diffs OpenRouter's
  cumulative key usage (`GET /api/v1/auth/key`) between turns. Falls back to
  opencode's `info.cost` last.
- **State** is persisted per session under
  `~/.local/state/opencode/cost-tracker/`.

## Notes

- Cost is attributed by response order; a summary/title request is consumed
  silently so it never counts toward the prompt total (it still counts toward
  the session total).
- The prompt total resets on each new user message and accumulates across the
  assistant turns that message triggers.
- The key-usage fallback measures usage across the whole API key, so a key
  shared with other apps can inflate a fallback delta.

## License

MIT
