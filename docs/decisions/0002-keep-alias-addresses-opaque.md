# 2. Keep alias addresses opaque and separate from policy

## Status

Superseded by [ADR 0005](0005-generate-readable-random-aliases.md)

## Context

An alias address could encode information such as a username, merchant, creation time, or TTL. That would make some addresses self-describing, but it would also expose policy to recipients, make policy changes awkward, and allow senders to construct or guess addresses. The companion app already provides a place to generate aliases, choose expiration times, and display lifecycle information.

## Decision

We will generate alias local parts on the server using a cryptographically secure random number generator with at least 96 bits of entropy. Addresses will contain no meaningful prefix, label, merchant, timestamp, lease duration, or other policy. Clients will request an alias and its expiration settings but will not choose the local part. The database will be the sole source of truth for expiry and behavior, and changing policy will never change the address.

## Consequences

Recipients cannot infer or manipulate an alias's lease from its address, and users can change policy without replacing the address. Random addresses are harder to remember or type, so copy and share actions are essential. The server must look up stored policy for every alias and handle the extremely unlikely event of a generation collision. The app, rather than the address, must communicate expiry and status.
