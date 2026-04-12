---
name: approve-feature
description: Approve a workflow stage and move state forward deterministically.
---

## Must
- update the correct stage review state
- record actor
- record timestamp
- append review history
- move workflow forward if appropriate

## Stage effects
- approving `product_spec` moves the feature toward `in_tdd`
- approving `technical_design` advances to task planning
- approving `tasks` moves feature to `ready_for_implementation`
- approving `handoff` may move feature to `done`
