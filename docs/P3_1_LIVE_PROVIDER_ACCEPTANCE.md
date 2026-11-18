# P3.1 Live Provider Acceptance

Status: ready for user device acceptance.

This checklist is for the signed local app bundle at `build/DeskPet.app`. Codex automated validation must not send real provider requests, read real secrets, or inspect provider raw headers/reasoning. Use the app UI manually for the live-provider checks below.

## Signed App Gate

1. Build the app with `scripts/build_app.sh release`.
2. Verify `codesign --verify --deep --strict build/DeskPet.app`.
3. Verify `plutil -lint build/DeskPet.app/Contents/Info.plist`.
4. Launch `build/DeskPet.app`.
5. Configure a provider and model using the normal Provider UI. Paste the API key only into the app UI.

## Manual Live Provider Tests

1. Native tool provider:
   - Configure an OpenAI-compatible provider whose saved capability includes tool calling.
   - Ask: `现在几点?`
   - Expected: the turn completes through the bounded loop, invokes `get_current_datetime`, and returns the current local time without exposing reasoning, headers, or secrets.

2. JSON fallback provider:
   - Configure Ollama, or an OpenAI-compatible/LM Studio provider without tool-calling capability.
   - Ask: `现在几点?`
   - Expected: the model uses the strict JSON decision fallback, the app invokes `get_current_datetime`, and the turn completes with a visible final answer.

3. Unsupported provider:
   - Configure Anthropic, Gemini, or Custom HTTP.
   - Ask a tool-requiring prompt such as `现在几点?`
   - Expected: the app does not attempt tool execution through that unsupported adapter and gives a safe limitation/fallback response.

4. Privacy check:
   - Confirm no UI surface shows provider raw headers, authorization values, Keychain contents, raw request payloads, or provider reasoning.

5. Concurrency check:
   - Send two messages rapidly.
   - Expected: only one active chat loop is accepted for the current conversation; the UI clears busy/transient state after completion.

6. Timeout check:
   - Use an intentionally slow local/mock provider only if available through the app UI.
   - Expected: the turn stops with a model/tool timeout state and no late result mutates the final message.

7. Signed bundle check:
   - Confirm the tested app is the signed bundle from `build/DeskPet.app`, not a debug binary.

8. Acceptance result:
   - If tests 1-7 pass on the user machine with a real configured provider, P3.1 can advance to P4.
