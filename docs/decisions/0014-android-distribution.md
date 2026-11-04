# 14. Distribute the Android app through signed GitHub Releases

## Status

Accepted

## Context

The Android shell is a management client for a self-hosted server, so there is no single operator-controlled store. Distribution must produce reproducible, signed builds, and the signing key must stay under project control so a newer build can install over an existing one. The project already publishes source and artifacts from GitHub and builds with Nix. Google Play adds account, review, and policy overhead, and F-Droid requires reproducible builds and a metadata merge request; neither is available on day one.

## Decision

Publish signed release builds on the repository's GitHub Releases page. `.github/workflows/android-release.yml` builds a release APK and AAB on a version tag, signs them from the upload keystore, and attaches them to the release with checksums. The Gradle build reads signing material from a git-ignored `keystore.properties` locally and from CI secrets in the workflow; the keystore and its passwords are backed up outside the repository.

The management origin is baked in at build time, so a deployment either builds its own signed APK with `-PwickmailManagementOrigin=https://<host>` or reuses a build made for that host. The workflow takes the origin as an input so a deployment can produce its own release from the same source and signing configuration. The project publishes a reference build with the default origin for evaluation.

The update path is: a user installs the signed APK, and later installs the newer signed APK; Android's package manager rejects an update signed with a different key, so the same key must sign every release. Operators who want automatic updates can publish the same signed builds to an F-Droid repository or Google Play.

## Consequences

Releases are reproducible from a tag, the signing key remains with the project, and users can verify each artifact against its checksum. Sideloaded APKs do not update themselves, so users re-install each release unless an additional channel is used. The upload key becomes a durable secret whose loss prevents existing installs from upgrading, so it needs an explicit backup and rotation plan. Publishing to a store later is additive and does not change the signing identity.
