import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Alias } from "wickmail-core";
import { useApi } from "../api/context.js";
import { CopyButton, ShareButton } from "../components/CopyButton.js";
import { Field, StatusMessage } from "../components/ui.js";
import { describeError } from "../lib/errors.js";
import {
  LEASE_PRESETS,
  buildCreateAliasRequest,
  defaultGenerateOptions,
  validateGenerateOptions,
  type GenerateOptions,
  type LeasePreset,
} from "../lib/generate.js";
import { formatExact } from "../lib/format.js";

/** Props for {@link GenerateDialog}. */
export interface GenerateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (alias: Alias) => void;
}

/**
 * The generate flow. The user chooses a label, purpose, and lease; the server
 * generates and stores the address, and only then is it shown as usable. There
 * is no field for the local part.
 */
export function GenerateDialog({ open, onClose, onCreated }: GenerateDialogProps): ReactNode {
  const { client } = useApi();
  const [options, setOptions] = useState<GenerateOptions>(defaultGenerateOptions);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<Alias | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setOptions(defaultGenerateOptions());
      setError(null);
      setCreated(null);
      dialogRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  function patch(next: Partial<GenerateOptions>): void {
    setOptions((current) => ({ ...current, ...next }));
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const now = Date.now();
    const invalid = validateGenerateOptions(options, now);
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const request = buildCreateAliasRequest(options, now);
      const response = await client.createAlias(request);
      setCreated(response.alias);
      onCreated(response.alias);
    } catch (reason) {
      // The entered values are preserved so the user can correct and retry.
      setError(describeError(reason).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <h2 id="generate-title">Generate alias</h2>
        {created === null ? (
          <form className="form" onSubmit={(event) => void onSubmit(event)}>
            <Field
              label="Label"
              htmlFor="generate-label"
              hint="A name you will recognize, such as a merchant."
            >
              <input
                id="generate-label"
                name="label"
                type="text"
                value={options.label}
                maxLength={200}
                required
                autoComplete="off"
                onChange={(event) => patch({ label: event.target.value })}
              />
            </Field>
            <Field
              label="Purpose"
              htmlFor="generate-purpose"
              hint="Optional notes, such as an order number."
            >
              <textarea
                id="generate-purpose"
                name="purpose"
                value={options.purpose}
                maxLength={2000}
                rows={2}
                onChange={(event) => patch({ purpose: event.target.value })}
              />
            </Field>
            <Field label="Expiration" htmlFor="generate-preset">
              <select
                id="generate-preset"
                name="preset"
                value={options.preset}
                onChange={(event) => patch({ preset: event.target.value as LeasePreset })}
              >
                {LEASE_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </Field>
            {options.preset === "custom" ? (
              <Field label="Expires at" htmlFor="generate-custom">
                <input
                  id="generate-custom"
                  name="customExpiresAt"
                  type="datetime-local"
                  value={options.customExpiresAt}
                  onChange={(event) => patch({ customExpiresAt: event.target.value })}
                />
              </Field>
            ) : null}
            <div className="field field-checkbox">
              <input
                id="generate-renew"
                name="renewOnOutbound"
                type="checkbox"
                checked={options.renewOnOutbound}
                onChange={(event) => patch({ renewOnOutbound: event.target.checked })}
              />
              <label htmlFor="generate-renew">Renew this alias when outbound mail is sent</label>
              <p className="field-hint">
                Inbound mail never renews an alias. This only affects mail you send through it.
              </p>
            </div>
            {error !== null ? <StatusMessage tone="error">{error}</StatusMessage> : null}
            <div className="dialog-actions">
              <button type="button" className="button" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="button button-primary" disabled={submitting}>
                {submitting ? "Generating…" : "Generate"}
              </button>
            </div>
          </form>
        ) : (
          <div className="generate-result">
            <p className="muted">Your alias is ready. Copy or share it now.</p>
            <p className="address address-large" data-testid="generated-address">
              {created.address}
            </p>
            <p className="muted">
              {created.expiresAt === null
                ? "No expiry"
                : `Expires ${formatExact(created.expiresAt)}`}
            </p>
            <div className="row-actions">
              <CopyButton
                value={created.address}
                label="Copy address"
                className="button button-primary"
              />
              <ShareButton value={created.address} />
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                onClick={() => {
                  setCreated(null);
                  setOptions(defaultGenerateOptions());
                }}
              >
                Generate another
              </button>
              <button type="button" className="button button-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
