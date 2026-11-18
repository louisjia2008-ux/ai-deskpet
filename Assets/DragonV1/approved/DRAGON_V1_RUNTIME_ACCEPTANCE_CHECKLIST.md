# DragonV1 Runtime Acceptance Checklist

RUNTIME_HUMAN_ACCEPTANCE = FAILED

Failure reason:
"DragonV1 wing animation and repeated wing rework attempts failed human visual review. Wings appear artificial, panel-like, disconnected, structurally incorrect, and unsuitable for desktop companion quality."

Runtime safety decision:
DragonV1 should not be loaded by runtime. With no accepted manifest, or with
only rejected DragonV1 metadata/assets present, the renderer must select the
vector fallback and report:

selectedRenderer = vectorFallback
fallbackReason = dragonV1RejectedOrNoAcceptedManifest

Use this checklist on a real macOS runtime/device pass. Mark exactly one status
for each row after observing the running app.

| Check | PASS | FAIL | NEEDS_FIX | Notes |
|---|---|---|---|---|
| launch without env flag uses fallback | [ ] | [ ] | [ ] | |
| launch with DESKPET_ENABLE_DRAGON_V1_ASSETS=1 uses PNG DragonV1 | [ ] | [ ] | [ ] | |
| character size unchanged | [ ] | [ ] | [ ] | |
| character anchor unchanged | [ ] | [ ] | [ ] | |
| nest/home placement unchanged | [ ] | [ ] | [ ] | |
| window size stable | [ ] | [ ] | [ ] | |
| dragon z-order correct | [ ] | [ ] | [ ] | |
| idle hover stable | [ ] | [ ] | [ ] | |
| fly left loop seamless | [ ] | [ ] | [ ] | |
| fly right loop seamless | [ ] | [ ] | [ ] | |
| takeoff transition natural | [ ] | [ ] | [ ] | |
| land transition natural | [ ] | [ ] | [ ] | |
| no crash on missing DragonV1 assets | [ ] | [ ] | [ ] | |
| no obvious CPU/memory regression | [ ] | [ ] | [ ] | |
| long-term desktop comfort | [ ] | [ ] | [ ] | |

## Evidence To Record

- App build/run method and git revision or diff snapshot.
- Whether `DESKPET_ENABLE_DRAGON_V1_ASSETS` was unset or set to `1`.
- DragonV1 debug diagnostics for renderer selection and loaded clip counts.
- Short screen recording or screenshots for fallback, idle hover, flight, takeoff, and land.
- Any observed visual discomfort, jitter, z-order issue, crash, or performance regression.

RUNTIME_HUMAN_ACCEPTANCE = FAILED
