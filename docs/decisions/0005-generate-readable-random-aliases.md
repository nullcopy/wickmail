# 5. Generate readable random aliases

## Status

Accepted

Supersedes [ADR 0002](0002-keep-alias-addresses-opaque.md).

## Context

Opaque random tokens prevent recipients from inferring policy, but they are difficult to read, remember, dictate, and transcribe. Users may need to communicate an alias verbally or enter it on a device where the companion app's copy action is unavailable. A readable address such as `green.farm@example.com` can preserve random generation and policy separation without those usability costs.

## Decision

We will generate alias local parts from randomly selected, human-readable dictionary words. The default form will be two common lowercase words separated by a dot, such as `green.farm`. Word lists will avoid offensive terms, homophones, and unnecessarily long or difficult words. The server will use unbiased random selection, enforce address uniqueness, and retry with a new combination or an additional word on collision.

Words will be selected independently of labels, merchants, ownership, expiration, and other policy. Clients will not choose the local part. Addresses will be identifiers rather than secrets, and no security control will depend on their being unguessable.

## Consequences

Aliases will be easier to read, communicate, and type while expiration remains changeable without changing the address. A word-based namespace is smaller than a long random-token namespace, so collisions and enumeration are more feasible and must be handled without treating addresses as credentials. Curating word lists adds maintenance, and two-word addresses may still be misheard, but they remain substantially more usable than opaque tokens.
