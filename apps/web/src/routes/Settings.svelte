<script lang="ts">
  import type { ApiToken, MailCredentialResponse, Scope } from "@wickmail/core";
  import type { VersionInfo } from "../lib/api";
  import { session } from "../lib/session.svelte";
  import { LEASE_PRESETS, THRESHOLD_PRESETS, type Preferences } from "../lib/preferences";
  import { formatAbsolute } from "../lib/format";
  import { isApiError } from "../lib/errors";
  import { confirm } from "../lib/confirm.svelte";
  import { toasts } from "../lib/toasts.svelte";
  import Spinner from "../components/Spinner.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import CopyButton from "../components/CopyButton.svelte";
  import { nativeBridge, type NativeAppLockState } from "../lib/native";

  const ALL_SCOPES: Scope[] = [
    "aliases:read",
    "aliases:write",
    "quarantine:read",
    "quarantine:write",
    "messages:read",
    "messages:reply",
  ];

  let version = $state<VersionInfo | null>(null);
  let versionError = $state<unknown>(null);
  let credential = $state<MailCredentialResponse | null>(null);
  let credentialError = $state<unknown>(null);
  let tokens = $state<ApiToken[]>([]);
  let tokensError = $state<unknown>(null);
  let loading = $state(true);

  let defaultLease = $state(String(session.preferences.defaultLeaseSeconds ?? "never"));
  let defaultRenew = $state(session.preferences.defaultRenewOnOutbound);
  let threshold = $state(String(session.preferences.expiringSoonSeconds));

  let issuedToken = $state<string | null>(null);
  let issuedMailPassword = $state<string | null>(null);
  let busy = $state(false);
  let actionError = $state<unknown>(null);

  let tokenName = $state("");
  let tokenScopes = $state<Scope[]>(["aliases:read"]);
  let tokenExpiry = $state("none");

  // The Android shell injects this bridge; it is absent in a browser.
  const native = nativeBridge();
  let nativeLock = $state<NativeAppLockState | null>(null);

  async function load(): Promise<void> {
    loading = true;
    versionError = null;
    credentialError = null;
    tokensError = null;
    try {
      version = await session.client.getVersion();
    } catch (caught) {
      versionError = caught;
    }
    try {
      credential = await session.client.getMailCredential();
    } catch (caught) {
      if (isApiError(caught) && caught.isNotFound) {
        credential = { configured: false, createdAt: null, rotatedAt: null, revokedAt: null };
      } else {
        credentialError = caught;
      }
    }
    try {
      tokens = (await session.client.listTokens()).items;
    } catch (caught) {
      tokensError = caught;
    }
    loading = false;
  }

  $effect(() => {
    void load();
  });

  $effect(() => {
    if (!native) return;
    void native
      .getAppLock()
      .then((state) => (nativeLock = state))
      .catch(() => {
        // The shell may be busy; the section stays hidden until it answers.
      });
  });

  async function setAppLock(enabled: boolean): Promise<void> {
    if (!native) return;
    try {
      nativeLock = await native.setAppLock(enabled);
      toasts.success(enabled ? "App lock enabled" : "App lock disabled");
    } catch {
      toasts.error("Could not update the app lock");
    }
  }

  async function setLockTimeout(seconds: number): Promise<void> {
    if (!native) return;
    try {
      nativeLock = await native.setLockTimeout(seconds);
    } catch {
      toasts.error("Could not update the lock timeout");
    }
  }

  function savePreferences(event: SubmitEvent): void {
    event.preventDefault();
    const next: Preferences = {
      defaultLeaseSeconds: defaultLease === "never" ? null : Number(defaultLease),
      defaultRenewOnOutbound: defaultRenew,
      expiringSoonSeconds: Number(threshold),
    };
    session.updatePreferences(next);
    toasts.success("Preferences saved");
  }

  function toggleScope(scope: Scope): void {
    tokenScopes = tokenScopes.includes(scope)
      ? tokenScopes.filter((value) => value !== scope)
      : [...tokenScopes, scope];
  }

  async function createToken(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (tokenScopes.length === 0) return;
    busy = true;
    actionError = null;
    issuedToken = null;
    try {
      const expiresAt =
        tokenExpiry === "none"
          ? null
          : new Date(Date.now() + Number(tokenExpiry) * 1000).toISOString();
      const issued = await session.client.createToken({
        name: tokenName.trim(),
        scopes: tokenScopes,
        expiresAt,
      });
      issuedToken = issued.token;
      tokenName = "";
      await load();
    } catch (caught) {
      actionError = caught;
    } finally {
      busy = false;
    }
  }

  async function revokeToken(token: ApiToken): Promise<void> {
    const confirmed = await confirm.ask({
      title: "Revoke token?",
      message: `Revoke "${token.name}"? Clients using it will lose access immediately.`,
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!confirmed) return;
    busy = true;
    actionError = null;
    try {
      await session.client.revokeToken(token.id);
      toasts.success("Token revoked");
      await load();
    } catch (caught) {
      actionError = caught;
    } finally {
      busy = false;
    }
  }

  async function rotateCredential(): Promise<void> {
    busy = true;
    actionError = null;
    issuedMailPassword = null;
    try {
      const result = await session.client.rotateMailCredential();
      issuedMailPassword = result.password;
      credential = result.credential;
      toasts.success("Mail credential rotated");
    } catch (caught) {
      actionError = caught;
    } finally {
      busy = false;
    }
  }

  async function revokeCredential(): Promise<void> {
    const confirmed = await confirm.ask({
      title: "Revoke mail credential?",
      message: "IMAP and SMTP clients will no longer authenticate until a new credential is set.",
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!confirmed) return;
    busy = true;
    actionError = null;
    try {
      credential = await session.client.revokeMailCredential();
      toasts.success("Mail credential revoked");
    } catch (caught) {
      actionError = caught;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Settings · Wickmail</title></svelte:head>

<section class="page">
  <header class="page-header">
    <div>
      <h1>Settings</h1>
      <p class="muted">Defaults, credentials, tokens, and server information.</p>
    </div>
    <button type="button" class="button" onclick={() => session.logout()}>Sign out</button>
  </header>

  {#if loading}
    <Spinner label="Loading settings" />
  {:else}
    {#if actionError}
      <ErrorBanner error={actionError} />
    {/if}

    <section class="panel" aria-labelledby="defaults-heading">
      <h2 id="defaults-heading">Defaults</h2>
      <form onsubmit={savePreferences} class="stack">
        <label class="field">
          <span>Default lease duration</span>
          <select bind:value={defaultLease}>
            {#each LEASE_PRESETS as preset (preset.seconds)}
              <option value={String(preset.seconds)}>{preset.label}</option>
            {/each}
            <option value="never">No expiry</option>
          </select>
        </label>
        <label class="choice">
          <input type="checkbox" bind:checked={defaultRenew} />
          Renew new aliases when you reply as them
        </label>
        <label class="field">
          <span>Expiring-soon threshold</span>
          <select bind:value={threshold}>
            {#each THRESHOLD_PRESETS as preset (preset.seconds)}
              <option value={String(preset.seconds)}>{preset.label}</option>
            {/each}
          </select>
        </label>
        <p class="muted">Preferences are stored in this browser. Credentials and tokens are not.</p>
        <button type="submit" class="button button-primary">Save preferences</button>
      </form>
    </section>

    {#if native}
      <section class="panel" aria-labelledby="android-heading">
        <h2 id="android-heading">Android app</h2>
        <label class="choice">
          <input
            type="checkbox"
            checked={nativeLock?.enabled ?? false}
            disabled={!nativeLock || !nativeLock.available}
            onchange={(event) => setAppLock(event.currentTarget.checked)}
          />
          Require unlock when the app returns
        </label>
        <label class="field">
          <span>Lock after</span>
          <select
            value={String(nativeLock?.timeoutSeconds ?? 60)}
            disabled={!nativeLock || !nativeLock.available}
            onchange={(event) => setLockTimeout(Number(event.currentTarget.value))}
          >
            <option value="0">Immediately</option>
            <option value="60">1 minute</option>
            <option value="300">5 minutes</option>
            <option value="900">15 minutes</option>
          </select>
        </label>
        {#if nativeLock && !nativeLock.available}
          <p class="muted">
            This device has no biometric or screen-lock authentication, so the app lock is
            unavailable.
          </p>
        {/if}
        <p class="muted">
          The app lock is a local convenience. It does not replace signing in to the server.
        </p>
      </section>
    {/if}

    <section class="panel" aria-labelledby="credential-heading">
      <h2 id="credential-heading">Mail credential</h2>
      {#if credentialError}
        <ErrorBanner error={credentialError} onRetry={load} />
      {:else if credential}
        {#if issuedMailPassword}
          <div class="banner banner-success" role="status">
            <strong>New mail password</strong>
            <p class="address">{issuedMailPassword}</p>
            <p class="muted">This password is shown once. Store it in your mail client now.</p>
            <CopyButton value={issuedMailPassword} label="Copy password" />
          </div>
        {/if}
        <p>
          {credential.configured ? "Configured" : "Not configured"}
          {#if credential.rotatedAt}
            · last rotated {formatAbsolute(credential.rotatedAt)}
          {/if}
          {#if credential.revokedAt}
            · revoked {formatAbsolute(credential.revokedAt)}
          {/if}
        </p>
        <div class="actions">
          <button type="button" class="button" onclick={rotateCredential} disabled={busy}>
            {credential.configured ? "Rotate password" : "Set password"}
          </button>
          {#if credential.configured}
            <button
              type="button"
              class="button button-danger"
              onclick={revokeCredential}
              disabled={busy}
            >
              Revoke
            </button>
          {/if}
        </div>
      {/if}
    </section>

    <section class="panel" aria-labelledby="tokens-heading">
      <h2 id="tokens-heading">API tokens</h2>
      {#if tokensError}
        <ErrorBanner error={tokensError} onRetry={load} />
      {:else}
        {#if issuedToken}
          <div class="banner banner-success" role="status">
            <strong>New token</strong>
            <p class="address">{issuedToken}</p>
            <p class="muted">This token is shown once. It is never stored in the browser.</p>
            <CopyButton value={issuedToken} label="Copy token" />
          </div>
        {/if}

        {#if tokens.length === 0}
          <p class="muted">No tokens.</p>
        {:else}
          <ul class="record-list">
            {#each tokens as token (token.id)}
              <li class="record">
                <div class="record-body">
                  <p class="record-title">{token.name}</p>
                  <p class="muted">
                    {token.prefix}… · {token.scopes.join(", ")}
                    {#if token.expiresAt}· expires {formatAbsolute(token.expiresAt)}{/if}
                    {#if token.revokedAt}· revoked {formatAbsolute(token.revokedAt)}{/if}
                  </p>
                </div>
                {#if !token.revokedAt}
                  <button
                    type="button"
                    class="button button-small button-danger"
                    onclick={() => revokeToken(token)}
                    disabled={busy}>Revoke</button
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        <form onsubmit={createToken} class="stack">
          <label class="field">
            <span>Token name</span>
            <input type="text" bind:value={tokenName} placeholder="ci" required />
          </label>
          <fieldset class="field">
            <legend>Scopes</legend>
            {#each ALL_SCOPES as scope (scope)}
              <label class="choice">
                <input
                  type="checkbox"
                  checked={tokenScopes.includes(scope)}
                  onchange={() => toggleScope(scope)}
                />
                {scope}
              </label>
            {/each}
          </fieldset>
          <label class="field">
            <span>Expiry</span>
            <select bind:value={tokenExpiry}>
              <option value="none">No expiry</option>
              <option value="2592000">30 days</option>
              <option value="31536000">1 year</option>
            </select>
          </label>
          <button
            type="submit"
            class="button button-primary"
            disabled={busy || tokenScopes.length === 0}
          >
            Create token
          </button>
        </form>
      {/if}
    </section>

    <section class="panel" aria-labelledby="server-heading">
      <h2 id="server-heading">Server</h2>
      {#if versionError}
        <ErrorBanner error={versionError} onRetry={load} />
      {:else if version}
        <dl class="definition">
          <dt>Product</dt>
          <dd>{version.product}</dd>
          <dt>Version</dt>
          <dd>{version.version}</dd>
          <dt>API contract</dt>
          <dd>{version.apiContractVersion}</dd>
          <dt>Origin</dt>
          <dd>{typeof window === "undefined" ? "" : window.location.origin}</dd>
          <dt>Authentication</dt>
          <dd>{session.tokenMode ? "API token (this session only)" : "Session cookie"}</dd>
        </dl>
      {/if}
    </section>
  {/if}
</section>
