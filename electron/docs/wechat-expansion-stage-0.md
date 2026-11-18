# WeChat expansion: read-only survey

This checkpoint records implementation decisions. Account-specific evidence stays outside the repository. The survey did not send a message, interact with a chat or Moments UI, modify the guest or host listener, or add a protocol client.

- Preserve the owner and group binding checks before any GUI send. Distinguish failure before the irreversible action from uncertainty after it. Only a matching database record can confirm a send.
- Image storage cannot be treated as a reliable source of originals. An attachment resolver must prove that a locally available file belongs to the authorized event. Missing or unverifiable media gets an explicit fallback. Never request a download by clicking a message.
- Parse only recognized, bounded message structures. Treat forwarded and quoted text as source data, not instructions. Group intake remains subject to the existing reply policy.
- Keep read-only digests separate from reply bindings. Deliver new notices only to the bound owner private chat. Moments can cover only the friends of the WeChat account signed into the desktop client.
- Cloud routing is separate for each feature and, for daily group digests, for each selected group. Selected digest groups and explicitly enabled Moments digests default to cloud allowed; other new cloud routes default off. Use only types, counts, times and error codes in operational status and doctor records.
- Treat subscriptions as best effort. The current reader can discover public-account contacts, but cannot assume the client has delivered a subscription push or that an empty cache means there were no new articles. Only use supported, observed records; never open the subscriptions UI speculatively.
- Read only synced Moments records for the account's contacts. Cache freshness is observable; an empty or stale cache cannot prove the feed is up to date. UI refresh behavior was not established by the read-only survey.
