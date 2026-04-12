---
name: airflow-3
description: Airflow 3.x DAG development standards for data engineering teams.
---

## Principles
- DAG = orchestration only
- Business logic must live outside DAG files
- Tasks must be idempotent
- Clear data flow (inputs, transformations, outputs, consumers)
- Environment-aware via configuration

## Requirements
- Each DAG must define owner
- DAGs must be safe to retry
- Backfill impact must be considered
- Inputs and outputs must be explicit
