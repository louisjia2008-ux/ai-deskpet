# Capability Catalog

The model can only reference capabilities that the runtime exposes through
`CapabilityCatalogSnapshot`. The snapshot is derived from `CapabilityCatalog` and the active
`AgentPolicy`.

Rules:

- capability IDs must be exact string matches from the catalog
- no fuzzy matching or dynamic model-created IDs
- `toolsAllowed=false` exposes an empty capability snapshot
- distribution tier limits remove permanently denied capabilities
- unknown capability IDs fail validation and never reach `ToolExecuting`

Reminder creation is represented by `reminder.local.create` for structured decisions. The legacy
`reminders.create` ID remains registered for existing seams and compatibility tests.

Every side effect still goes through `CapabilityBroker`; catalog membership is necessary but never
sufficient for execution.
