# Wickmail web management app design

## Purpose

Provide a responsive interface for generating readable random aliases with chosen expiration times, browsing and managing generated aliases, recovering quarantined mail, replying as an alias, and understanding why an alias is in its current state.

The app is served from the management API's origin and is reused by the Android shell. It is not a general email client: it includes a focused reply composer and a limited recent-message list tied to aliases, but no folder browsing, arbitrary composition, or general search.

## Primary user flows

### Generate an alias

1. Select **Generate alias**.
2. Optionally enter a merchant, order, or purpose.
3. Select an expiration preset or choose a custom expiration time.
4. Review renewal behavior.
5. Ask the server to generate and store the alias.
6. Present the returned readable address, such as `green.farm@example.com`, with prominent **Copy** and **Share** actions.

The user never enters or edits the local part. The address is randomly assembled from common words and contains no expiration or other policy. The app reads expiry from the API, never from the address, and only shows the alias as usable after server creation succeeds.

### Reuse an alias for another purchase

1. Open the alias.
2. Select **New purchase / Renew and copy**.
3. Choose the additional lease duration.
4. Confirm renewal.
5. Return with the address copied or ready to share.

Reuse is allowed for another purchase or interaction with the same merchant or purpose. An alias is never reassigned to a different owner.

### Reply as an alias

1. Open a message from the recent-message list.
2. Select **Reply**.
3. The app selects the reply identity from trusted provenance:
   - Exactly one alias received the message: that alias is selected, with the primary identity offered as an alternative.
   - No alias received the message: the primary identity is selected.
   - Multiple aliases received the message: the app prompts and requires a choice.
4. Compose the reply in the focused composer, with the recipient, subject, optional quoted text, and alias identity pre-filled.
5. Send. The server validates the identity and queues the message.
6. The alias renews when the message is accepted and queued.

If the message is quarantined, sending a reply prompts to recover the message and renew or enable the alias first. If the alias is expired with `renew_on_outbound` disabled, the app explains the block and offers renewal or another identity instead of sending silently.

### Recover expired mail

1. Open the quarantine list or an expired alias.
2. Review sender, subject, and received time.
3. Select **Recover** or **Recover and renew**.
4. Confirm that the message is available in the inbox.

## Screens

### Dashboard

- Active, expiring-soon, expired, and quarantined counts
- Search by label, purpose, or address
- Filters for state and expiry: expiring within 24 hours, 7 days, a custom range, or no expiry
- Sort controls for expiry, recently used, and recently created
- Expiry sorting shows the soonest expiration first and places aliases without expiry last
- Recently-used sorting shows the latest inbound or user activity first; aliases with no activity fall back to creation time
- Expiry is the default sort
- Prominent generate button
- Quarantine indicator

Each alias row shows:

- Label and readable random address
- State
- Expiry or "No expiry"
- Last-used time
- Renewal behavior
- Recent quarantined-message count

### Alias detail

- Copy and share actions
- State and exact expiry timestamp
- Human-readable explanation, such as "Expires in 3 days"
- Renew, extend, disable, and enable actions
- Label, purpose, and policy editing
- Recent messages with a reply action
- Recent lifecycle events
- Recent quarantined messages

### Messages

A limited list of recent messages tied to aliases and quarantine. It supports filtering by alias, sender, and date, and shows the reply alias provenance. It does not provide folder browsing, arbitrary composition, or general message search.

### Reply composer

- Reply recipient from the original message, read-only
- Subject prefilled as a reply
- Reply identity selector constrained by provenance and ownership
- Plain-text body with an optional quoted original
- Send action that reports queued, rejected, or identity-error results
- No attachments in v1

### Quarantine

- Filter by alias and date
- Sender, subject, and received timestamp
- Recover, recover-and-renew, and delete actions
- Reply action that prompts to recover and renew first
- Retention deadline

This screen does not render message bodies in v1; the reply composer fetches sanitized reply context only when the user replies.

### Activity

Show lifecycle events such as:

- Created
- Renewed by outbound mail
- Manually extended
- Expired (derived)
- Message recovered
- Replied as alias
- Disabled or enabled

### Settings

- Default lease duration
- Default outbound-renewal behavior
- Expiring-soon threshold
- Session, credential, and API-token management
- Server and mailbox connection information

## UX requirements

- Destructive actions require confirmation.
- Disable and delete are visually distinct from renewal.
- Every expired alias offers an obvious recovery path.
- Multiple-alias replies always prompt; there is no silent identity selection.
- Identity errors explain which identity was rejected and offer valid alternatives.
- Errors preserve the user's entered values.
- Loading, empty, offline, and permission-error states are designed explicitly.
- Relative times are accompanied by exact timestamps where useful.
- Copy actions provide clear confirmation without exposing unnecessary details.
- The UI works at mobile and desktop widths.
- Controls support keyboard navigation, screen readers, reduced motion, and adequate contrast.

## Frontend behavior

- The server is the source of truth.
- The app consumes server-computed effective state and raw timestamps; it does not duplicate lease evaluation.
- Use the same-origin API to avoid unnecessary cross-origin credential handling.
- Refresh alias and message state after mutations.
- Handle conflicts by reloading current state rather than silently overwriting another change.
- Do not persist API tokens in browser storage.
- Do not inject credentials into page JavaScript.
- Avoid caching message bodies or quarantine metadata in persistent offline storage for v1.

## Acceptance criteria

- A user can generate and copy a readable seven-day alias, such as `green.farm@example.com`, in under a minute.
- The app offers no field for choosing the local part and never derives policy from the address.
- Users can filter aliases by state and expiry and sort them by expiry, recently used, or recently created.
- Aliases without expiry and aliases that have never been used have deterministic sort positions.
- A returning user can renew and copy an existing alias in two primary actions.
- Users can edit labels and purposes, change lease policy, and disable or re-enable aliases.
- Active, expired, and disabled states are visually unambiguous.
- The interface explains that inbound mail does not renew an alias.
- A reply to a message with exactly one receiving alias defaults to that alias.
- A reply to a message with multiple receiving aliases requires an explicit choice.
- A reply to a primary-only message uses the primary identity.
- The composer reports queued, rejected, and identity-error outcomes accurately.
- Quarantined mail can be recovered without using an IMAP client.
- All core flows work on both a phone-sized browser and a desktop browser.
