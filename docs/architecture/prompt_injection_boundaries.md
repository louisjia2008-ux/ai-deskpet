# Prompt Injection Boundaries

DeskPet treats user messages, screen summaries, file text, webpage text, and other external content
as untrusted data. Such content may influence conversation text, but it cannot change:

- capability policy
- tool permissions
- runtime system rules
- approval state
- schema rules
- task ledger semantics

Structured decisions are protected by local code, not prompt wording alone. The boundary is enforced
by:

- untrusted DTO decoding
- schema validation
- semantic validation
- capability catalog validation
- policy validation
- `CapabilityBroker` as the only grant boundary

If untrusted content asks the assistant to ignore previous instructions or execute commands, the raw
text remains data. It cannot create a grant or reach the executor without passing the local validators
and broker.
