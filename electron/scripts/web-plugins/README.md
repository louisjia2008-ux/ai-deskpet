# Local web plugin trial

This trial runs SearXNG and Crawl4AI on the same machine as DeskPet, without a paid search or extraction API. It does not install login items or start Docker. The prepared runtime lives outside the application bundle, so this is a local trial rather than a portable packaged dependency.

The runtime root must contain a Python 3.12 `venv` with SearXNG requirements, `crawl4ai==0.9.5`, FastAPI and Uvicorn; a pinned SearXNG checkout at `searxng`; and Playwright Chromium at `browsers`. Preparing those dependencies is a separate operation. The launcher never downloads or installs them.

Run with the prepared environment's interpreter:

```sh
"<runtime-root>/venv/bin/python" scripts/web-plugins/local_services.py start --runtime-root "<runtime-root>"
"<runtime-root>/venv/bin/python" scripts/web-plugins/local_services.py status --runtime-root "<runtime-root>"
"<runtime-root>/venv/bin/python" scripts/web-plugins/local_services.py stop --runtime-root "<runtime-root>"
```

Both services bind only to `127.0.0.1`: SearXNG uses port 8080 and the narrow Crawl4AI adapter uses 11235. The launcher refuses occupied ports and does not stop unrelated processes. Stop verifies the recorded PID, process start time, command and process group before signalling the group it created. Logs and caches remain within the runtime root. macOS proxy settings or existing proxy environment variables are reused; proxy values and tokens are not printed. PAC-only proxy configuration is not implemented by this trial launcher.

Settings → Plugins accepts the two local service origins. A randomly generated local Crawl4AI token is held in `<runtime-root>/crawl4ai-token` with mode 0600; paste it into the Crawl4AI token field and save. DeskPet stores it using the existing encrypted vault. This is a local-service credential, not a commercial API key. Test each saved configuration before enabling the plugin.

SearXNG needs JSON enabled and configured upstream search engines. Its settings are generated once, then preserved across starts. Upstream engines may deny access, return CAPTCHAs or provide irrelevant results, even when the local JSON API is responding. Inspect search relevance and reported engine errors; a nonempty result list alone is not acceptance.

The Crawl4AI adapter accepts one HTTPS URL, uses a fresh browser context, blocks service workers and downloads, and does not deserialize caller-provided browser/run configuration. No arbitrary hooks, JavaScript, profile paths or LLM settings are accepted. JavaScript from the requested public page still runs for rendering. Seed redirects are resolved manually and checked at every hop before navigation at the real final URL. The browser receives no redirect responses; later navigation and subresource redirects are refused. Read-only routing blocks non-HTTPS/private destinations and POST requests. Images, fonts, media and WebSockets are blocked. This can break interactive sites; extraction is intended for reading public pages rather than operating them.

This is application-level filtering, not an OS sandbox. DNS checks are not pinned proxy egress; a configured proxy can resolve names independently. Browser background traffic and all browser internals are not proved isolated by these route guards. Treat the configured local service and proxy as trusted components, retain these limitations, and do not expose this trial server to a network.

Use the bounded public smoke receipt tool:

```sh
"<runtime-root>/venv/bin/python" scripts/web-plugins/smoke.py --runtime-root "<runtime-root>" --output "<receipt.json>"
```

The smoke queries English/Chinese documentation and Los Angeles weather, reads official Crawl4AI/NWS pages, and checks authentication/private-target/hooks rejection. Receipts contain only bounded public result samples, timing, counts and hashes; the local token is never saved in them. These checks do not establish local-model answer quality or packaged-app acceptance.

SearXNG is AGPL-3.0-or-later. Crawl4AI's LICENSE includes Apache-2.0 text and an additional attribution requirement. This product includes software developed by UncleCode (https://x.com/unclecode) as part of the Crawl4AI project (https://github.com/unclecode/crawl4ai).
