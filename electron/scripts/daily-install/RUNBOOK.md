# Daily installation (macOS)

Copy `install.example.json` **outside the repository**, fill in the local values,
and protect it with mode `0600`. Create a private, separate stage directory first.
Default config location: `~/.config/deskpet/install.json`. Nothing discovers or
reads credentials or personal character settings.

```sh
scripts/daily-install/run.sh --plan --config=/absolute/path/to/install.json
```

The plan makes a new `0700` stage, records the installed ASAR as its baseline,
builds and certificate-signs a daily package, verifies its bundle/signing identity,
inventories the sealed flat WeChat resources against the source, audits the whole
package and runs release-policy tests and packaged WeChat acceptance with the
existing isolated profile/native-dialog stub and **one worker**. It calls the
canonical installer's `--plan-only` branch. It never reads the personal profile,
contacts/pauses the listener, quits the app, makes a backup or replaces anything.
Build or acceptance failures stop the plan and retain its evidence.

## Separate reviewed cutover — owner present

Do **not** run this during unattended development. Review the final source and
the exact `sourceSHA256`, `mainSHA256`, `asarSHA256` and predecessor from
`package-identity.json`. Add an exact entry to `../install-cutover-policy.mjs`,
preserving all predecessor `futureCron`, `nightlyDisabled`, `supplemental` and
`dormantTelegram` conditions. The runner never writes an approval policy. Do not
rebuild a reviewed binary merely for a policy-only change.

```sh
scripts/daily-install/run.sh --install --stage=/absolute/path/to/completed-stage
```

The owner must type the exact candidate hash in an interactive terminal. Alternatively,
when the owner has approved this exact build in conversation, the operator passes
`--approved-asar=<candidate asarSHA256>`; any other hash is refused. The approval
covers one build only and is never reused for a later candidate. The
installer preserves the previous pause state, requires a fresh paused heartbeat,
quits the exact daily app normally, and refuses live writers, locks or unresolved
recovery. The paused worker backup covers bindings, group policies, stable JSON
configuration, prior code, LaunchAgent and a SQLite backup with `integrity_check`.
It rechecks config hashes and paused PID throughout.

The stopped encrypted profile copy is inspected with the exact artifact's
isolated maintenance branch. Plaintext remains in that process; only hashes,
counts and schedule metadata leave it. A Keychain prompt may require one-time
**Allow**; never choose Always Allow or change ACLs. Follow any blocked result.
Reviews expire in 30 minutes; enabled future jobs require a 15-minute buffer.
The canonical installer rechecks exact baseline/live/copy/backup identities,
retained automation, grants and future work. No migration or new grant is made.

Before launch, verification compares both signed bundles, sealed resources and
the full backup/live profile manifest. The paused worker swap publishes its
checkpoint, copies only reviewed changed resources, requires a new fresh paused
launchd PID with the same protocol, and rolls code back on failure. Guest
prerequisites, node runtime, database and cursors stay in place; no VM is created
and no guest files are provisioned. The newest three install checkpoints remain.

The command **leaves the listener paused and app stopped**. The rollout owner
must verify existing owner/test-group bindings and the established cursor
baseline, then start the app normally. Only run the printed `update-worker.py
resume` command afterwards; it preserves a pre-existing pause. A missing
baseline needs a separately scoped review, never an automatic cursor reset.

## Pre-launch rollback

Set `DESKPET_INSTALL_STAGE` to the same private stage. While paused, run
`update-worker.py rollback` if `applied-worker.json` exists, then `rollback-app.py`.
The latter verifies both signatures and all stopped live/backup profile hashes
before reversible same-filesystem renames. Never restore the SQLite snapshot
after messages were admitted or cursors changed without inspecting exact state:
doing so can lose or replay messages. Pause/baseline/recovery checks are not a
claim that native messaging acceptance has been performed.
