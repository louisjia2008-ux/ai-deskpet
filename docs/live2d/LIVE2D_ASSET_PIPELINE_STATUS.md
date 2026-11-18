# Live2D Asset Pipeline Status

## Status

BLOCKED_BY_MISSING_LAYER_PIXELS

## Read-Only Audit Source

`/path/to/workspace/Live 2D项目/live2d_model/psd_plan`

## Findings

- `layer_pixel_production_plan.json`: 129 `missing` statuses found.
- `audit/layer_pixel_audit_report.json`: `BLOCKED_BY_MISSING_LAYER_PIXELS`, 129 missing statuses found.
- `audit/psd_audit_report.json`: `BLOCKED_BY_MISSING_LAYER_PIXELS`.
- `audit/batch_01_mask_audit_report.json`: `BLOCKED_BY_MISSING_RECONSTRUCTED_PIXELS`.
- No formal `.model3.json`, `.moc3`, motions, expressions, or physics export was found.

## Gate Result

- READY_FOR_LAYER_PRODUCTION: no.
- READY_FOR_HUMAN_REVIEW: partial external contact sheets exist, but missing reconstructed pixels keep production blocked.
- READY_FOR_PSD_BUILD: no.
- READY_FOR_LIVE2D_RIGGING: no.

## Rule

Automatically generated masks or extracted layer pixels must remain `human_review_pending` until a human reviewer accepts them. No draft or missing layer can enter the production runtime path.
