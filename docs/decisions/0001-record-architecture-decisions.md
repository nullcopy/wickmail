# 1. Record architecture decisions

## Status

Accepted

## Context

Wickmail's behavior depends on decisions about alias identity, lease renewal, mail retention, client responsibilities, and deployment. Their rationale is not always apparent from the resulting design or code. Without a record, future changes could inadvertently weaken privacy, lose mail, or make aliases impossible to manage.

## Decision

We will keep architecture decision records in `docs/decisions`. Each record will follow Michael Nygard's format: title, status, context, decision, and consequences. Records will be numbered sequentially, numbers will not be reused, and superseded records will remain in the repository with links to their replacements.

## Consequences

The reasoning behind significant decisions will remain available alongside the design and implementation. Recording decisions adds a small documentation cost and requires contributors to update the log when architecture changes. Superseding rather than rewriting records preserves history but requires readers to follow status links to find the current decision.
