import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { ReplyIdentity, ReplyResult } from "wickmail-core";
import { useApi } from "../api/context.js";
import { EmptyState, ErrorState, LoadingState, StatusMessage } from "../components/ui.js";
import { useAsync } from "../hooks/useAsync.js";
import { formatExact } from "../lib/format.js";
import {
  aliasIdForIdentity,
  classifyReplyFailure,
  defaultIdentity,
  identityKey,
  identityLabel,
  quoteOriginal,
  replySubject,
  requiresIdentityChoice,
  type ReplyFailure,
} from "../lib/reply.js";
import { navigate } from "../lib/router.js";

/** The reply composer for one message. */
export function ReplyComposerScreen({ id }: { id: string }): ReactNode {
  const { client } = useApi();
  const context = useAsync(() => client.getReplyContext(id), [client, id]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [includeQuote, setIncludeQuote] = useState(true);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ReplyResult | null>(null);
  const [failure, setFailure] = useState<ReplyFailure | null>(null);
  const [validation, setValidation] = useState<string | null>(null);

  const decision = context.data?.identity ?? null;
  const options = useMemo<ReplyIdentity[]>(() => decision?.options ?? [], [decision]);
  const mustChoose = decision !== null && requiresIdentityChoice(decision);

  useEffect(() => {
    if (decision !== null && decision.selected !== null) {
      setSelectedKey(identityKey(decision.selected));
    }
  }, [decision]);

  const selected = useMemo(
    () => options.find((option) => identityKey(option) === selectedKey) ?? null,
    [options, selectedKey],
  );

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (context.data === null) {
      return;
    }
    const choice = selected ?? (mustChoose ? null : defaultIdentity(context.data.identity));
    if (choice === null) {
      setValidation("Choose which alias to send as.");
      return;
    }
    if (body.trim().length === 0) {
      setValidation("Enter a message before sending.");
      return;
    }
    setValidation(null);
    setSending(true);
    setFailure(null);
    try {
      const response = await client.submitReply(id, {
        aliasId: aliasIdForIdentity(choice),
        body,
        ...(includeQuote && context.data.text.length > 0
          ? { quotedText: quoteOriginal(context.data.text) }
          : {}),
      });
      setResult(response);
    } catch (error) {
      // The entered body and identity are preserved on failure.
      setFailure(classifyReplyFailure(error));
    } finally {
      setSending(false);
    }
  }

  if (context.loading) {
    return <LoadingState label="Loading message…" />;
  }
  if (context.error !== null) {
    return <ErrorState error={context.error} onRetry={context.reload} />;
  }
  if (context.data === null) {
    return <EmptyState title="Message not found" />;
  }

  const message = context.data;

  if (result !== null) {
    return (
      <section className="screen" aria-labelledby="reply-sent-title">
        <h1 id="reply-sent-title">Reply queued</h1>
        <StatusMessage tone="success">
          Your reply was accepted and queued as{" "}
          {result.identity.kind === "alias" ? result.identity.address : "the primary address"}.
          {result.renewed
            ? ` The alias was renewed${result.expiresAt === null ? "" : ` until ${formatExact(result.expiresAt)}`}.`
            : ""}
        </StatusMessage>
        <div className="row-actions">
          <button type="button" className="button" onClick={() => navigate({ name: "messages" })}>
            Back to messages
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="screen" aria-labelledby="composer-title">
      <h1 id="composer-title">Reply</h1>
      <form className="form" onSubmit={(event) => void onSubmit(event)}>
        <div className="field">
          <label htmlFor="reply-to">To</label>
          <input id="reply-to" type="text" value={message.sender ?? "(unknown sender)"} readOnly />
        </div>
        <div className="field">
          <label htmlFor="reply-subject">Subject</label>
          <input id="reply-subject" type="text" value={replySubject(message.subject)} readOnly />
        </div>

        <fieldset className="field field-group">
          <legend>Send as</legend>
          {options.length === 0 ? (
            <p className="field-hint">No sending identity is available for this message.</p>
          ) : (
            options.map((option) => {
              const key = identityKey(option);
              return (
                <label key={key} className="radio">
                  <input
                    type="radio"
                    name="reply-identity"
                    value={key}
                    checked={selectedKey === key}
                    onChange={() => setSelectedKey(key)}
                  />
                  <span>{identityLabel(option)}</span>
                </label>
              );
            })
          )}
          {mustChoose ? (
            <p className="field-hint" role="note">
              Multiple aliases received this message. Choose one explicitly before sending.
            </p>
          ) : null}
        </fieldset>

        <div className="field">
          <label htmlFor="reply-body">Message</label>
          <textarea
            id="reply-body"
            value={body}
            rows={10}
            required
            onChange={(event) => setBody(event.target.value)}
          />
        </div>

        {message.text.length > 0 ? (
          <div className="field field-checkbox">
            <input
              id="reply-quote"
              type="checkbox"
              checked={includeQuote}
              onChange={(event) => setIncludeQuote(event.target.checked)}
            />
            <label htmlFor="reply-quote">Include the original message as quoted text</label>
          </div>
        ) : null}

        {message.text.length > 0 ? (
          <details className="original-message">
            <summary>Original message</summary>
            <pre>{message.text}</pre>
          </details>
        ) : null}

        <p className="field-hint">Attachments are not supported in this version.</p>

        {validation !== null ? <StatusMessage tone="error">{validation}</StatusMessage> : null}
        {failure !== null ? (
          <div role="alert" className={`status status-error failure-${failure.kind}`}>
            <p>{failure.message}</p>
            {failure.kind === "identity" ? (
              <p>
                {selected !== null ? `The rejected identity was ${identityLabel(selected)}. ` : ""}
                Choose a different identity above and send again.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => navigate({ name: "messages" })}>
            Cancel
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={sending || options.length === 0}
          >
            {sending ? "Sending…" : "Send reply"}
          </button>
        </div>
      </form>
    </section>
  );
}
