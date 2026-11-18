# P6 Agent OS Manual Acceptance

## Source Of Truth

Manual flows verify the current code paths:

- Memory Center: `MemoryView`, `MemoryModel`, `MemoryStore`
- Runtime: `PetAgentRuntimeCoordinator`, `AgentLoopController`, `ToolRegistry`
- Task Center: `AgentTaskActivityStore`, `TaskCenterView`, `AgentResultView`

## Data Flow

Each flow starts from the real app UI, then verifies the resulting memory store, task activity projection, or structured result rendering.

## FLOW 1: Explicit Preference Auto Memory

Input: “以后默认用中文回复我。”

Expected:

- No blocking confirmation modal.
- Lightweight “已记住” feedback appears.
- Memory Center “最近自动学习” contains the preference.
- The active memory can be edited or forgotten.
- After restart, the active memory still exists.

## FLOW 2: Date Request Does Not Enter Memory

Input: “告诉我当前日期和时间。”

Expected:

- `get_current_datetime` is called through the real ToolRegistry path.
- Task Center developer details show the real tool ID.
- Ordinary activity says it is getting local date/time.
- Memory Center has no date/time candidate.

## FLOW 3: Temporary Preference Is Not Permanent

Input: “这次查询机票我要靠窗。”

Expected:

- Working/session context can use the preference.
- It does not immediately become active long-term memory.
- It does not require long-term preference confirmation.

## FLOW 4: Sensitive Memory Requires Confirmation

Use a fake fixture, not real sensitive information.

Expected:

- Candidate appears under “需要确认”.
- UI explains why confirmation is needed.
- Before confirmation, it does not enter agent context retrieval.

## FLOW 5: Forget

Input: “忘记我默认使用中文这条偏好。”

Expected:

- Active memory is removed from retrieval.
- Memory history preserves superseded/archived state.
- Later context no longer contains that preference.

## FLOW 6: Real Tool Transparency

Input a request that must call `get_current_datetime`.

Expected:

- User layer shows “正在获取本地日期和时间”.
- Developer detail shows `get_current_datetime`.
- No hidden thinking, raw provider JSON, or raw arguments are shown.
- Floating Chat live activity clears after terminal.
- Task Center history remains.

## FLOW 7: Structured Travel Sample

Open a DEBUG sample travel task or inject `P6DebugTravelFixture.sampleDocument`.

Expected:

- Chat shows only a short summary.
- “查看结果” or Task Center opens the full result.
- Three SAMPLE / DEBUG flight options render as comparison cards/table.
- Sources and freshness are visible.
- Production release manifests do not include a sample travel tool.

## FLOW 8: Invalid ResultDocument

Inject an unsupported component or schema version.

Expected:

- App does not crash.
- Result view is not attached.
- User keeps text fallback.
- Developer diagnostics include validation issue.

## FLOW 9: Restart Recovery

Create active memory and a completed structured result, then restart.

Expected:

- Active memory reloads.
- Completed task result replays in Task Center.
- Terminal live card does not reappear.
- No duplicate memory/result record is generated.

## Ownership

Manual acceptance should not edit signing, Keychain, entitlements, provider adapters, or release tool registration.

## Failure Handling

If GUI smoke is blocked by signing, permission prompts, or local environment, record `BLOCKED_NEEDS_HUMAN_ACCEPTANCE` for that flow only and keep automated tests as the source of code-level evidence.

## Migration

Run flows with both a fresh memory store and a legacy `memories.json` containing accepted, pending, ignored, and corrupt items.

## Security Boundary

Never use real API keys, tokens, passwords, addresses, payment cards, health records, or private calendar data during manual acceptance.

## Test Coverage

Automated coverage lives in `P6MemoryV2Tests`, `P6ResultSchemaTests`, `P6PermissionGrantTests`, and `P6ActivityProjectionTests`.

## Deferred Work

Real flight search, browser automation, airline adapters, payment, and sandbox mini apps are out of scope for P6 manual acceptance.
