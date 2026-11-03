# 9. Separate management authentication from mail authentication

## Status

Accepted

## Context

Wickmail is self-hosted and single-user in v1. The management app can change leases and read quarantine metadata, while IMAP/SMTP credentials are stored in mail clients. Sharing one credential would let a compromised mail client alter policy, and it would make session revocation and account recovery harder to reason about. Self-hosting also needs a safe first-run path with no default credentials.

## Decision

Management authentication and Dovecot mail authentication will be separate credentials for the same single user. The management app supports a password hashed with Argon2id and optional passkeys, with server-side revocable sessions. IMAP/SMTP uses a separate mail password that can be rotated or revoked independently.

First run uses a CLI bootstrap command that creates the user and prints a single-use setup token; there are no default credentials. Account recovery is performed locally through the CLI or one-time recovery codes, not through email. Programmatic access uses hashed, scoped, expirable, revocable API tokens that are shown once at creation and never stored in browser storage.

## Consequences

A leaked mail client credential cannot change alias policy, and a leaked management session cannot read mail over IMAP. Users manage two credentials, though the management app can guide rotation. Recovery requires local access to the host, which is appropriate for self-hosting but means a lost management credential is not recoverable remotely.
