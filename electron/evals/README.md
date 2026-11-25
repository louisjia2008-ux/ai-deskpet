# Quality evals

Fixed test sets for three model-driven features, so a prompt or model change is measured instead of judged by feel:

| Suite | What it checks | Cases |
|---|---|---|
| `auto-memory` | What the background reader saves from the owner's messages: lasting facts in, one-off requests, moods, questions, secrets, duplicates and pasted instructions out. | 16 |
| `memory-sleep` | The nightly tidy-up: merges that keep every detail and let the newer statement win, different facts kept apart, trivial or finished entries dropped, selective promotion. | 10 |
| `persona` | Desktop replies with the real system prompt (persona, character sheet, moment, memories, mood tag): voice, relationship, substance, honesty and fit. | 12 |

Each case gets programmatic checks (the production parser and filters, required and forbidden content, format) and a
model judge with a fixed rubric; both halves weigh the same. The requests go through the production OpenAI adapter
with the production instructions, so they match what the app sends.

## Run

```sh
# once: store an OpenAI API key in the login keychain (it prompts for the key)
# (macOS's prompt cuts input at 128 characters, too short for an sk-proj key, so read it from the clipboard;
#  the key is briefly visible to other local processes as an argument)
security add-generic-password -U -s deskpet-eval -a openai -w "$(pbpaste)"; pbcopy </dev/null

npm run eval:memory      # auto-memory + memory-sleep
npm run eval:persona     # persona
npm run eval             # everything
```

Settings (environment variables):

- `DESKPET_EVAL_MODEL`: model under test (default `gpt-6.2-sol`); `DESKPET_EVAL_JUDGE_MODEL`: judge (defaults to the same model).
- `DESKPET_EVAL_REPEAT`: runs per case, to see how stable an answer is (default 1).
- `DESKPET_EVAL_PROFILE`: a local JSON file `{"persona": {...}, "character": {...}}` with your own companion. Keep it
  outside the repository. Without it the persona suite uses a made-up companion.
- `DESKPET_EVAL_OUT`: where reports go (default `eval-results/`, ignored by git). Each run writes a Markdown table and
  the full JSON, including every model output.
- `OPENAI_API_KEY` works instead of the keychain item. It is only ever sent to api.openai.com.
- `DESKPET_EVAL_BASE_URL`: another OpenAI-compatible endpoint. It uses its own key: `DESKPET_EVAL_API_KEY`, or the
  keychain item `deskpet-eval-endpoint` with the endpoint's host name as account.
- Behind a proxy, Node's fetch does not use the system setting: add `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://host:port`.

The suites cost a few dozen requests each and are not part of `npm test`. All cases are synthetic; add real ones
only to a local copy.
