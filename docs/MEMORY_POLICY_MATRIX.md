# Memory Policy Matrix

## Source Of Truth

The executable policy is `MemoryPolicyEngine` in `Sources/AICore/Memory.swift`. `MemoryView` only renders the resulting projection and does not contain policy logic.

## Data Flow

`MemoryCandidate` values enter `MemoryModel.ingest`. The policy returns one of: `ignore`, `keepEphemeral`, `observe`, `autoCommit`, `requireConfirmation`, or `reject`.

| Input type | Decision | Scope | Persisted | Confirmation | Example |
| --- | --- | --- | --- | --- | --- |
| Explicit stable low-risk preference | `autoCommit` | `semantic` or `procedural` | Yes | No | “以后默认用中文回复。” |
| Explicit working style | `autoCommit` | `procedural` | Yes | No | “修改代码后一定运行测试。” |
| One-off task preference | `keepEphemeral` | `working` or `session` | Short TTL only | No | “这次查询机票我要靠窗。” |
| Repeated behavior below threshold | `observe` | Proposed scope | Yes as evidence | No | First or second repeated choice |
| Repeated behavior at threshold | `autoCommit` | Proposed scope | Yes | No | 3 evidences across 2 sessions, confidence >= 0.80 |
| Sensitive personal information | `requireConfirmation` | Candidate scope | Pending only | Yes | Test fixture address or health fact |
| Conflicting active value, ambiguous | `requireConfirmation` | Candidate scope | Pending only | Yes | New default language without clear update wording |
| Conflicting active value, explicit update | `autoCommit` with supersession | Candidate scope | Yes | No | “从现在开始默认英文。” |
| Password, API key, token, OTP, private key | `reject` | None | No | No | “记住我的 API key ...” |
| Date/time request | `ignore` | None | No | No | “今天几号？” |
| Plain task prompt | `ignore` | None | No | No | “帮我整理这个文件。” |
| Assistant-authored content | `ignore` | None | No | No | Model response text |
| Tool raw arguments | `ignore` | None | No | No | JSON arguments from tool call |
| Scheduler/internal running state | `ignore` | None | No | No | `schedulerStart`, `running` |
| Memory disabled, long-term candidate | `ignore` | None | No | No | Semantic preference while long-term memory is off |
| Memory disabled, working/session candidate | `keepEphemeral` | `working` or `session` | Short TTL only | No | Current task slot/value |

## Ownership

The model can propose only `MemoryCandidate`. Repository mutation belongs to `MemoryModel`, and final policy belongs to `MemoryPolicyEngine`.

## Lifecycle

Auto-committed records are active immediately and show in “已记住” and/or “最近自动学习”. Confirmation-required records show only in “需要确认”. Observed and ephemeral records do not enter normal long-term retrieval unless policy later upgrades them.

## Failure Handling

Rejected and ignored candidates do not throw. Store write failure is contained in the memory path and must not fail the agent response.

## Migration

Legacy accepted memory is mapped through `MemoryLegacyMapper`. Legacy pending memory is run through policy again so old date/time/task-prompt junk becomes ignored.

## Security Boundary

The policy is deterministic and does not trust model confidence alone. Prohibited secrets cannot be saved through explicit user wording, auto-learning, migration, or tool outcomes.

## Test Coverage

`P6MemoryPolicyTests`, `P6MemoryRepositoryTests`, and `P6MemoryRetrievalTests` cover the matrix. `MemoryPolicyTests` from M5 still covers legacy forbidden-content and auto-only behavior.

## Deferred Work

Per-category auto-learning opt-out is represented in UI copy but not yet backed by a category-specific policy preference store.
