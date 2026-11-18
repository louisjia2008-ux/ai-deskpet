# P9F Human Acceptance

Stage: P9F_REAL_SYSTEM_HANDOFF_CONFORMANCE_AND_HUMAN_ACCEPTANCE

Status: P9F_IMPLEMENTED_HUMAN_ACCEPTANCE_INCOMPLETE

Date/time: 2026-08-01 13:50-14:05 GMT+08:00; phone semantics closeout update 2026-08-02 02:21 GMT+08:00

Build configuration:
- Debug: built with `xcodebuild -project DeskPet.xcodeproj -scheme DeskPet -configuration Debug -derivedDataPath /private/tmp/deskpet-p9f-real-acceptance-debug-derived CODE_SIGNING_ALLOWED=NO build`; phone semantics closeout used `/private/tmp/deskpet-p9f-phone-closeout-debug-derived/Build/Products/Debug/DeskPet.app`.
- Release: built with `xcodebuild -project DeskPet.xcodeproj -scheme DeskPet -configuration Release -derivedDataPath /private/tmp/deskpet-p9f-phone-closeout-release-derived CODE_SIGNING_ALLOWED=NO build`.

App binary paths:
- Debug: `/private/tmp/deskpet-p9f-real-acceptance-debug-derived/Build/Products/Debug/DeskPet.app`
- Release: `/private/tmp/deskpet-p9f-phone-closeout-release-derived/Build/Products/Release/DeskPet.app`

Acceptance mode:
- Real system handoff was explicitly enabled only in the manual acceptance process with `DESKPET_P9F_REAL_HANDOFF_ACCEPTANCE=1`.
- The enablement flag was not written to shell profiles, `project.yml`, shared schemes, `Info.plist`, UserDefaults, or production configuration.
- Without explicit acceptance mode, real system acceptance is refused and the product remains on fake or injected dispatchers.
- Private applications were hidden before capture where possible. Captures were reviewed and sanitized when a system window exposed non-fixture UI.
- Phone acceptance must stop at the system phone or FaceTime handler UI. No call may be placed.
- Directions acceptance must stop at route preview. Navigation must not be started.
- Website acceptance may verify only the initial handoff target host. No login, form submission, purchase, booking, download, or message send is allowed.

Artifact directories:
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/`
- `.codex_tmp/p9f-phone-handler-closeout-20260802-0221/`

Fixtures:
- Map place: `P9F Apple Park Visitor Center`, coordinate `37.3327,-122.0053`, public address `10600 N Tantau Ave, Cupertino, CA 95014`.
- Directions: origin `1 Infinite Loop, Cupertino, CA 95014`, destination `10600 N Tantau Ave, Cupertino, CA 95014`; preview only.
- Directions denied: destination `10600 N Tantau Ave, Cupertino, CA 95014` with a permission-gated current-location fixture and denied decision before dispatcher invocation.
- Website: `https://www.apple.com/retail/appleparkvisitorcenter/`, host `www.apple.com`, classification `officialWebsite`.
- Phone handler: reserved non-personal test fixture; documents and artifacts record only `+1 650 *** 0100`.

## Real Map Place

Scenario: realMapPlace

Date and local time: 2026-08-01 13:50:25 GMT+08:00

Build configuration: Debug

App binary path: `/private/tmp/deskpet-p9f-real-acceptance-debug-derived/Build/Products/Debug/DeskPet.app`

Fixture: `P9F Apple Park Visitor Center`, `37.3327,-122.0053`, `10600 N Tantau Ave, Cupertino, CA 95014`

Expected behavior: DeskPet preview shows the fixed place name and destination, explicit confirmation invokes the real system dispatcher once, Apple Maps opens the correct place or coordinate, DeskPet returns to `handedOff`, no search/model/tool re-executes, and selecting another card or marker does not auto-dispatch.

Observed behavior: The real DeskPet Debug app invoked `SystemPlaceHandoffDispatcher` once. Apple Maps was running after handoff. The sanitized Maps screenshot was visually inspected and shows the Apple Park target marker, not user location, search-region center, an empty map, or a different candidate. DeskPet returned to a `handedOff` terminal screenshot.

Explicit confirmation observed: true in the acceptance harness path; no separate human PASS was recorded.

External application opened: true, Maps (`com.apple.Maps`)

Target correctness: visually inspected from sanitized screenshot; artifact remains `systemTargetVerified=false` until human acceptance records PASS.

Navigation started: false

Phone call placed: not applicable

Form submitted: not applicable

Dispatcher invocation count: 1

Duplicate count: 0

DeskPet terminal state: `handedOff`, `loadingVisible=false`, `pendingActivityCount=0`

Window/focus behavior: DeskPet did not crash, the confirmation sheet and spinner were not residual, Floating Chat was not reported permanently missing, and candidate or marker selection did not auto-dispatch. The harness returned focus to DeskPet for the terminal screenshot and did not force external focus as product behavior.

Recovery behavior: covered by `handedOffRecovery`; recovered `handedOff` without another dispatch.

Screenshot paths:
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_result_before_realMapPlace.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_preview_realMapPlace.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/system_realMapPlace.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_handed_off_terminal_realMapPlace.png`

Artifact path: `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/real_map_place_artifact.json`

Human acceptance: FAIL

Notes: Runtime evidence is positive for dispatch count, terminal state, and sanitized visual target. This is not a human PASS. The initial Maps capture exposed non-fixture recent-history UI and was overwritten by a sanitized crop before final artifact review.

## Real Directions

Scenario: realDirections

Date and local time: 2026-08-01 13:52:10 GMT+08:00

Build configuration: Debug

App binary path: `/private/tmp/deskpet-p9f-real-acceptance-debug-derived/Build/Products/Debug/DeskPet.app`

Fixture: origin `1 Infinite Loop, Cupertino, CA 95014`, destination `10600 N Tantau Ave, Cupertino, CA 95014`

Expected behavior: DeskPet preview shows the fixed origin and destination, explicit confirmation invokes the real system dispatcher once, Apple Maps opens route preview only, origin and destination are not reversed, navigation is not started, DeskPet returns to `handedOff`, and route estimate, Local Discovery search, and model calls are not re-executed.

Observed behavior: The real DeskPet Debug app invoked the real dispatcher once. Apple Maps opened a route preview. The sanitized route screenshot was visually inspected and showed origin `1 Infinite Loop` and destination `Apple Park Visitor Center` in the correct order. No Go, Start, or localized navigation-start control was clicked. DeskPet returned to `handedOff`.

Explicit confirmation observed: true in the acceptance harness path; no separate human PASS was recorded.

External application opened: true, Maps (`com.apple.Maps`)

Target correctness: visually inspected from sanitized screenshot; artifact remains `systemTargetVerified=false` until human acceptance records PASS.

Navigation started: false

Phone call placed: not applicable

Form submitted: not applicable

Dispatcher invocation count: 1

Duplicate count: 0

DeskPet terminal state: `handedOff`, `loadingVisible=false`, `pendingActivityCount=0`

Window/focus behavior: DeskPet did not crash, no spinner or confirmation sheet remained, and candidate or marker selection did not auto-dispatch.

Recovery behavior: no model, tool, or route-estimate reexecution was recorded (`modelReexecutionCount=0`, `toolReexecutionCount=0`); full quit/relaunch recovery was executed on the map handoff record.

Screenshot paths:
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_result_before_realDirections.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_preview_realDirections.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/system_realDirections.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_handed_off_terminal_realDirections.png`

Artifact path: `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/real_directions_artifact.json`

Human acceptance: FAIL

Notes: Runtime evidence is positive for no navigation and no reexecution. This is not a human PASS. The initial Maps capture exposed non-fixture recent-history UI and was overwritten by a sanitized crop before final artifact review.

## Directions Denied

Scenario: directionsDenied

Date and local time: 2026-08-01 13:56:01 GMT+08:00

Build configuration: Debug

App binary path: `/private/tmp/deskpet-p9f-real-acceptance-debug-derived/Build/Products/Debug/DeskPet.app`

Fixture: destination `10600 N Tantau Ave, Cupertino, CA 95014`; origin `permission-gated current location fixture`

Expected behavior: DeskPet permission denial occurs before dispatcher invocation, Maps does not open, terminal state becomes `rejected`, no fallback uses cached location, user location, or search-region center, and no permanent spinner remains.

Observed behavior: The real DeskPet Debug app rendered the permission-gated directions preview, denied through the P9F authorizer, recorded `dispatchStatus=rejected`, invoked no dispatcher, and produced a rejected terminal screenshot. Maps was already running before this scenario from earlier scenarios; before/after process state stayed running, so the proof is no new dispatcher invocation plus unchanged process/window observation rather than process absence.

Explicit confirmation observed: true in the acceptance harness path; the denial was not a separate human-clicked permission UI PASS.

External application opened: false for this scenario

Target correctness: not applicable

Navigation started: false

Phone call placed: not applicable

Form submitted: not applicable

Dispatcher invocation count: 0

Duplicate count: 0

DeskPet terminal state: `rejected`, `loadingVisible=false`, `pendingActivityCount=0`

Window/focus behavior: DeskPet did not crash, no spinner or confirmation sheet remained, and candidate or marker selection did not auto-dispatch.

Recovery behavior: not applicable for rejected no-dispatch scenario.

Screenshot paths:
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_directions_permission_preview.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_directions_permission_denied.png`

Artifact path: `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/directions_denied_artifact.json`

Human acceptance: FAIL

Notes: Runtime evidence is positive for no dispatch and rejected terminal. This is not a human PASS because the denial was fixture-driven and Maps was already running from earlier acceptance scenarios.

## Real Website

Scenario: realWebsite

Date and local time: 2026-08-01 13:59:45 GMT+08:00

Build configuration: Debug

App binary path: `/private/tmp/deskpet-p9f-real-acceptance-debug-derived/Build/Products/Debug/DeskPet.app`

Fixture: `https://www.apple.com/retail/appleparkvisitorcenter/`, host `www.apple.com`, classification `officialWebsite`

Expected behavior: DeskPet preview shows host and official classification with an external-leave warning, explicit confirmation invokes the real system dispatcher once, the default browser opens the initial allowed host, no webpage interaction occurs, DeskPet records `handedOff`, and no duplicate dispatch occurs.

Observed behavior: The real DeskPet Debug app invoked the real dispatcher once. Safari was running after handoff, and the sanitized browser screenshot shows the Apple Park Visitor Center page title/address region. Browser URL automation via AppleScript did not complete due macOS automation restrictions, so the initial host was not independently read back from Safari. DeskPet returned to `handedOff`.

Explicit confirmation observed: true in the acceptance harness path; no separate human PASS was recorded.

External application opened: true, Safari (`com.apple.Safari`)

Target correctness: partially observed from sanitized screenshot; independent host readback was blocked.

Navigation started: false

Phone call placed: not applicable

Form submitted: false

Dispatcher invocation count: 1

Duplicate count: 0

DeskPet terminal state: `handedOff`, `loadingVisible=false`, `pendingActivityCount=0`

Window/focus behavior: DeskPet did not crash, no spinner or confirmation sheet remained, and candidate or marker selection did not auto-dispatch.

Recovery behavior: no model or tool reexecution was recorded. Full quit/relaunch recovery was executed on a map handoff record, not this browser handoff.

Screenshot paths:
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_result_before_realWebsite.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_preview_realWebsite.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/system_realWebsite.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_handed_off_terminal_realWebsite.png`

Artifact path: `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/real_website_artifact.json`

Human acceptance: FAIL

Notes: Runtime evidence is positive for Safari handoff, no form submission, and DeskPet terminal state. This is not a human PASS because host readback was not independently verified. The browser screenshot was cropped to avoid exposing unrelated private tabs.

## Real Phone Handler

Scenario: realPhoneHandler

Date and local time: 2026-08-01 14:03:57 GMT+08:00; clean rerun for phone handler semantics 2026-08-02 02:21:37 GMT+08:00

Build configuration: Debug

App binary path: `/private/tmp/deskpet-p9f-real-acceptance-debug-derived/Build/Products/Debug/DeskPet.app`; rerun path `/private/tmp/deskpet-p9f-phone-closeout-debug-derived/Build/Products/Debug/DeskPet.app`

Fixture: redacted display `+1 650 *** 0100`; normalized test number was not stored in the artifact.

Expected behavior: DeskPet preview shows a redacted test number, explicit confirmation invokes the real system dispatcher once, the system phone or FaceTime handler UI appears, the human cancels that system UI, DeskPet remains `handedOff`, and no call is placed.

Observed behavior: The 2026-08-02 real DeskPet Debug app clean rerun used the production `ExternalURLHandlerResolving` path before confirmation. In the DeskPet App process, `NSWorkspace.shared.urlForApplication(toOpen:)` resolved a registered phone handler with bundle identifier `com.apple.mobilephone`, and the async `NSWorkspace.open(url, configuration:)` completion returned a running application with bundle identifier `com.apple.mobilephone` and no error category. DeskPet recorded `dispatchStatus=acceptedBySystem`, `executionState=handedOff`, `dispatcherInvocationCount=1`, `duplicateDispatchCount=0`, and one sanitized terminal Task Center activity. No visible system phone handler UI was human-observed or captured, so `handlerUIVisibility` remains `unverified` in the code-generated artifact and phone human acceptance is not PASS.

Explicit confirmation observed: true in the acceptance harness path; no separate human PASS was recorded.

External application opened: system open accepted by `NSWorkspace`; visible handler UI not human-observed.

Target correctness: handler registration and async open target were recorded as `com.apple.mobilephone`; external handler UI visibility was not verified by a human.

Navigation started: false

Phone call placed: false

Form submitted: not applicable

Dispatcher invocation count: 1

Duplicate count: 0

DeskPet terminal state: `handedOff`, `loadingVisible=false`, `pendingActivityCount=0`

Window/focus behavior: DeskPet did not crash, no spinner or confirmation sheet remained, and candidate or marker selection did not auto-dispatch. No visible system handler UI was available to cancel.

Recovery behavior: not accepted because the phone handler did not open.

Screenshot paths:
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_result_before_realPhoneHandler.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_preview_realPhoneHandler.png`
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_handed_off_terminal_realPhoneHandler.png`
- `.codex_tmp/p9f-phone-handler-closeout-20260802-0221/screenshots/deskpet_result_before_realPhoneHandler.png`
- `.codex_tmp/p9f-phone-handler-closeout-20260802-0221/screenshots/deskpet_preview_realPhoneHandler.png`
- `.codex_tmp/p9f-phone-handler-closeout-20260802-0221/screenshots/deskpet_handed_off_terminal_realPhoneHandler.png`

Artifact paths:
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/real_phone_handler_artifact.json`
- `.codex_tmp/p9f-phone-handler-closeout-20260802-0221/real_phone_handler_artifact.json`

Human acceptance: FAIL

Notes: This blocks P9F completion. The old `P9F_BLOCKED_SYSTEM_HANDLER_UNAVAILABLE` conclusion is not supported for the 2026-08-02 App-process rerun because a handler was resolved and async open was accepted. Correct blocking detail for this pass is `P9F_PHONE_HANDLER_UI_NOT_OBSERVED`, with overall P9F remaining `P9F_IMPLEMENTED_HUMAN_ACCEPTANCE_INCOMPLETE`. Do not report `P9F_REAL_SYSTEM_HANDOFF_CONFORMANCE_AND_HUMAN_ACCEPTANCE_COMPLETE`.

## Recovery After Real Handoff

Scenario: handedOffRecovery

Date and local time: 2026-08-01 14:05:34 GMT+08:00

Build configuration: Debug

App binary path: `/private/tmp/deskpet-p9f-real-acceptance-debug-derived/Build/Products/Debug/DeskPet.app`

Fixture: recovered the prior map handoff record for `P9F Apple Park Visitor Center`

Expected behavior: after a successful real handoff, quitting and restarting DeskPet restores `handedOff` from checkpoint without reopening Maps, browser, FaceTime, or a phone handler; dispatcher invocation count does not increase.

Observed behavior: The restarted real DeskPet Debug app recovered `handedOff` from checkpoint. Maps was already running before and after, but no dispatcher invocation occurred on recovery. The artifact records `recoveredFromCheckpoint=true`, `dispatcherInvocationCount=0`, `autoReexecuted=false`, `loadingVisible=false`, and `pendingActivityCount=0`.

Explicit confirmation observed: false; recovery scenario must not dispatch or ask for confirmation.

External application opened: false on recovery

Target correctness: recovered terminal state only; no new system target opened.

Navigation started: false

Phone call placed: not applicable

Form submitted: not applicable

Dispatcher invocation count: 0

Duplicate count: 0

DeskPet terminal state: `handedOff`, `loadingVisible=false`, `pendingActivityCount=0`

Window/focus behavior: DeskPet did not crash, no spinner or confirmation sheet remained, and no external App was auto-opened by recovery.

Recovery behavior: PASS as runtime evidence for the map handoff record; still not a full P9F human PASS because phone handler acceptance failed and no human PASS record exists.

Screenshot paths:
- `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/screenshots/deskpet_recovered_handed_off_terminal.png`

Artifact path: `.codex_tmp/p9f-real-handoff-acceptance-20260801-133534/real_handoff_recovery_artifact.json`

Human acceptance: FAIL

Notes: Runtime recovery evidence passed for the map handoff record and did not reexecute.

## Overall Human Acceptance Decision

Real map place: FAIL until a human records PASS, despite positive runtime evidence.

Real directions preview: FAIL until a human records PASS, despite positive runtime evidence.

Directions denied: FAIL until a human records PASS; fixture-driven denial produced correct no-dispatch runtime evidence.

Real website: FAIL because independent browser host readback was blocked and no human PASS was recorded.

Real phone handler: FAIL because the App-process resolver found `com.apple.mobilephone` and async open was accepted, but no visible phone handler UI was human-observed. `phoneCallActuallyPlaced=false`.

Handed-off recovery: runtime PASS for map handoff recovery, but overall human acceptance remains FAIL.

Final gate status for this pass: P9F_IMPLEMENTED_HUMAN_ACCEPTANCE_INCOMPLETE

Blocking status detail: P9F_PHONE_HANDLER_UI_NOT_OBSERVED
