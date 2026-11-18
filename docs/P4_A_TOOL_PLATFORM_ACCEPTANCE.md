# P4-A Tool Platform Acceptance

Status: ready for user device acceptance after automated validation passes.

This checklist is for the signed local app bundle at `build/DeskPet.app`. Codex automated validation must not send real provider requests, read real secrets, inspect provider reasoning, read real Calendar data, or request macOS Calendar permission. Use the app UI manually for the live checks below.

## Signed App Gate

1. Build the app with `scripts/build_app.sh release`.
2. Verify `codesign --verify --deep --strict build/DeskPet.app`.
3. Verify `plutil -lint build/DeskPet.app/Contents/Info.plist`.
4. Launch `build/DeskPet.app`.
5. Configure a provider and model using the normal Provider UI. Paste any API key only into the app UI.
6. Open Settings and confirm the Tool management area shows the four release tools with enablement, risk, category, availability, and system permission state where applicable.

## Manual Tool Tests

### TEST 1 - Time Tool

Input:

```text
请调用工具告诉我当前本地时间。
```

Expected:

- The assistant returns a concrete local time.
- The chat does not show JSON, call ID, raw observation, raw tool result, or internal loop state.

### TEST 2 - System Profile

Input:

```text
请调用工具告诉我当前 macOS 版本、CPU 架构和 DeskPet 版本。
```

Expected:

- The assistant only returns allowlisted system information.
- It does not show username, home directory, hostname, serial number, hardware UUID, IP address, MAC address, environment variables, shell configuration, or file paths.

### TEST 3 - Frontmost Application

Before the test, switch to Safari, Finder, Xcode, or another normal app.

Input:

```text
请调用工具告诉我当前正在使用哪个应用。
```

Expected:

- The assistant returns the application name.
- It does not return window title, webpage title, document title, browser URL, file path, Accessibility tree, or screen content.

### TEST 4 - Today's Calendar Without Permission

Input:

```text
请查看我今天的日历安排。
```

Expected:

- The app uses an explicit permission flow or explains that Calendar permission is missing.
- It does not retry forever, crash, or request Calendar permission automatically at app launch.
- Calendar data is not read while system permission is missing.

### TEST 5 - Today's Calendar After Permission

After manually allowing Calendar permission through the app's explicit flow or macOS Settings, run:

```text
请查看我今天有哪些日历安排，只告诉我时间和标题。
```

Expected:

- The assistant returns today's events only.
- It does not show notes, attendees, meeting links, location, raw recurrence rules, alarms, attachments, internal EventKit identifiers, creation metadata, or last-modified metadata.

### TEST 6 - Disabled Tool

In Settings, turn off the current application tool, then run:

```text
请告诉我当前使用哪个应用。
```

Expected:

- The model cannot call the disabled tool.
- The next turn's provider schema does not expose that tool.
- The user receives a clear limitation explanation instead of a raw platform error.

### TEST 7 - Turn Snapshot

Start a tool request, then disable that same tool in Settings while the request is running.

Expected:

- The current turn uses the snapshot captured at turn start, or stops according to the existing loop policy.
- The changed setting applies to the next turn.
- The turn does not fail because the registry changed midway.

### TEST 8 - Two Chat Entrypoints

Start a tool call in Floating Chat, then open the control panel while the turn is active.

Expected:

- Both entrypoints share the same runtime/chat state.
- The tool is not executed twice.
- The final assistant message is inserted once.
- Transient busy state clears after success, failure, denial, cancellation, or timeout.

### TEST 9 - Privacy Surfaces

Inspect chat, task flow, Settings, and any visible status surfaces after the tests.

Expected:

- No raw arguments, raw tool result, provider reasoning, call ID, internal schema, authorization value, Keychain content, or debug policy text is visible.
- Tool summaries are short, user-safe phrases from the tool manifest.

## Acceptance Result

Codex does not mark these manual tests as passed. After the user completes TEST 1 through TEST 9 on the signed bundle, record the result here or in the release notes for the next phase.
