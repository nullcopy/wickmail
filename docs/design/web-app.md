# Wickmail web management app design

## Purpose

Provide a responsive interface for creating aliases, managing leases, recovering quarantined mail, and understanding why an alias is in its current state.

The app is served from the management API's origin and is reused by the Android shell.

## Primary user flows

### Create an alias

1. Select **Create alias**.
2. Optionally enter a merchant, order, or purpose.
3. Select a lease duration.
4. Review renewal behavior.
5. Create the alias.
6. Present the completed address with prominent **Copy** and **Share** actions.

The generated address should only be shown as usable after server creation succeeds.

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
- Search and status filters
- Aliases sorted by expiry by default
- Prominent create button
- Quarantine indicator

Each alias row shows:

- Label and address
- State
- Expiry or "No expiry"
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

- A user can create and copy a seven-day alias in under a minute.
- A returning user can renew and copy an existing alias in two primary actions.
- Active, expired, and disabled states are visually unambiguous.
- The interface explains that inbound mail does not renew an alias.
- Quarantined mail can be recovered without using an IMAP client.
- All core flows work on both a phone-sized browser and a desktop browser.
