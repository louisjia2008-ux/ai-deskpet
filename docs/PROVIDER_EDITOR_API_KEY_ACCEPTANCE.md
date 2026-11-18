# Provider Editor API Key Acceptance

Use only disposable test text such as `test-key-placeholder`. Do not use a real API key in screenshots, logs, fixtures, or notes.

## Manual Paste Flow

1. Launch DeskPet and open the Provider page.
2. Copy this disposable value with leading/trailing whitespace: `  test-key-placeholder  `.
3. Click `添加 Provider`.
4. Click the API Key field.
5. Press `Cmd+V`.
6. Toggle `显示` only if visual confirmation is needed; the field should contain `test-key-placeholder` without leading or trailing whitespace.
7. Toggle `隐藏`.
8. Repeat by clearing the field and clicking `粘贴`; the same trimmed value should appear.

## Edit Menu And Context Menu

1. With the API Key field focused, open `Edit`.
2. `Paste`, `Copy`, and `Select All` should be enabled when the text field can accept the command.
3. Right-click paste is acceptable when provided by the system text field. If the system context menu is unavailable in the current environment, `Cmd+V` and the `粘贴` button are the required acceptance paths.

## Failure Retention

1. Enter a disposable API Key and an intentionally unreachable Base URL such as `https://127.0.0.1:9`.
2. Save the provider, then run `测试连接`.
3. The status should show `Connection failed`.
4. Reopen the provider editor. The saved secret should be represented as saved or masked, never displayed in plaintext unless `显示` is toggled.

## Secret Handling

The disposable key must not appear in:

- `providers.json`
- test logs
- error notices
- diagnostics dumps
- UI text outside the API Key field while `显示` is active
