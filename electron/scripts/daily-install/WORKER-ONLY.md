# WeChat Python worker updates

This procedure updates the host listener for a reviewed Python change that uses the installed application's existing worker protocol and database schema. It rejects edits to the known schema modules and detected SQL schema statements. Review the worker patch and its authorization and failure tests, including compatibility with the current database and worker protocol, before requesting owner approval. Use the full daily installer for changes to the application, a dependency, the database schema, the worker protocol, or a non-Python worker resource.

From the Electron directory of a clean checkout, run the read-only plan with the full commit for the signed app currently installed. Use the same protected installation configuration as the full daily installer.

```sh
python3.14 -B scripts/daily-install/update-worker-only.py --plan \
  --baseline=<installed-git-commit> --config=<absolute-config-path>
```

The plan verifies the signed daily bundle against the configured certificate, reads the embedded source fingerprint, and checks the sealed app resources and the live worker resources against the baseline commit. It compares the candidate commit with the baseline and checks the candidate against the checkout on disk. Staged, unstaged, and untracked changes cause it to stop. It also checks ignored entries under the app's source and the worker directory. The output lists the worker file hashes and the `workerSHA256` to review. The digest identifies the baseline and candidate, the installed ASAR, the installation configuration, and both worker manifests.

After the owner approves that exact `workerSHA256` in conversation, apply the reviewed checkout using the same configuration and baseline.

```sh
python3.14 -B scripts/daily-install/update-worker-only.py \
  --approved-worker=<workerSHA256> --baseline=<installed-git-commit> \
  --config=<absolute-config-path>
```

Run one installation or recovery procedure at a time. Leave the listener's pause control alone while the update runs. The script waits for a new paused heartbeat from the configured launchd service. It saves the previous worker resources and a private SQLite backup with `integrity_check=ok` in a `worker-only-*` directory under `backupRoot`. It stops the paused service, replaces the approved Python files, removes bytecode for those modules, and starts the same service. The replacement must publish a new heartbeat with the existing protocol version. If the worker was running before the update, it must also publish a fresh running heartbeat after resume. An existing pause is preserved. If the pause marker is replaced during the update, recovery keeps the listener paused.

If the update fails after stopping the service, it pauses the listener, restores the previous code, and checks the previous listener's heartbeat. SQLite remains live through rollback to preserve messages and cursor advances admitted after the backup. Keep the backup as recovery evidence. If the process was forcibly terminated or reports `worker-rollback-incomplete`, leave the pause marker in place and review the newest verified checkpoint before attempting recovery.

This version supports one lightweight update from a matching signed baseline. A subsequent plan refuses a live worker that differs from the installed bundle. A reviewed full installation can establish a new matching baseline.
