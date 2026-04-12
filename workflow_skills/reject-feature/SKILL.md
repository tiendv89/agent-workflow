---
name: reject-feature
description: Reject a workflow stage while keeping lifecycle state consistent.
---

## Must
- record actor
- record timestamp
- record comment
- append history
- update `next_action`
- keep the feature in the correct lifecycle state for the rejected stage
