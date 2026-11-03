# Wickmail web management app design

## Purpose

Provide a responsive interface for generating readable random aliases with chosen expiration times, browsing and managing generated aliases, recovering quarantined mail, and understanding why an alias is in its current state.

The app is served from the management API's origin and is reused by the Android shell.

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

### Continue a support conversation

The alias detail view explains:

> Sending through this alias renews it for another 7 days. Replies from the merchant do not.

No manual action is required if the user sends through their normal email client.

### Recover expired mail

1. Open the quarantine list or expired alias.
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
- Recent lifecycle events
- Recent quarantined messages

### Quarantine

- Filter by alias and date
- Sender, subject, and received timestamp
- Recover, recover-and-renew, and delete actions
- Retention deadline

This screen does not render message bodies in v1.

### Activity

Show lifecycle events such as:

- Created
- Renewed by outbound mail
- Manually extended
- Expired
- Message recovered
- Disabled or enabled

### Settings

- Default lease duration
- Default outbound-renewal behavior
- Expiring-soon threshold
- Session and API-token management
- Server and mailbox connection information

## UX requirements

- Destructive actions require confirmation.
- Disable and delete are visually distinct from renewal.
- Every expired alias offers an obvious recovery path.
- Errors preserve the user's entered values.
- Loading, empty, offline, and permission-error states are designed explicitly.
- Relative times are accompanied by exact timestamps where useful.
- Copy actions provide clear confirmation without exposing unnecessary details.
- The UI works at mobile and desktop widths.
- Controls support keyboard navigation, screen readers, reduced motion, and adequate contrast.

## Frontend behavior

- The server is the source of truth.
- Use the same-origin API to avoid unnecessary cross-origin credential handling.
- Refresh alias state after mutations.
- Handle conflicts by reloading current state rather than silently overwriting another change.
- Do not persist API tokens in browser storage.
- Do not inject credentials into page JavaScript.
- Avoid caching quarantine metadata in persistent offline storage for v1.

## Acceptance criteria

- A user can generate and copy a readable seven-day alias, such as `green.farm@example.com`, in under a minute.
- The app offers no field for choosing the local part and never derives policy from the address.
- Users can filter aliases by state and expiry and sort them by expiry, recently used, or recently created.
- Aliases without expiry and aliases that have never been used have deterministic sort positions.
- A returning user can renew and copy an existing alias in two primary actions.
- Users can edit labels and purposes, change lease policy, and disable or re-enable aliases.
- Active, expired, and disabled states are visually unambiguous.
- The interface explains that inbound mail does not renew an alias.
- Quarantined mail can be recovered without using an IMAP client.
- All core flows work on both a phone-sized browser and a desktop browser.
