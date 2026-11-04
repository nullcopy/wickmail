import type { ReactNode } from "react";
import type { QuarantinedMessage } from "wickmail-core";
import { formatExact, formatRelativeTime } from "../lib/format.js";
import { retentionDeadline } from "../lib/quarantine.js";

/** Props for {@link QuarantineTable}. */
export interface QuarantineTableProps {
  messages: readonly QuarantinedMessage[];
  aliasAddresses: ReadonlyMap<string, string>;
  now: number;
  busyId: string | null;
  onRecover: (message: QuarantinedMessage) => void;
  onRecoverAndRenew: (message: QuarantinedMessage) => void;
  onDelete: (message: QuarantinedMessage) => void;
  onReply: (message: QuarantinedMessage) => void;
}

function senderLabel(message: QuarantinedMessage): string {
  return message.sender ?? "(unknown sender)";
}

function subjectLabel(message: QuarantinedMessage): string {
  return message.subject ?? "(no subject)";
}

/** A list of quarantined messages with recovery, delete, and reply actions. */
export function QuarantineTable({
  messages,
  aliasAddresses,
  now,
  busyId,
  onRecover,
  onRecoverAndRenew,
  onDelete,
  onReply,
}: QuarantineTableProps): ReactNode {
  return (
    <ul className="message-list">
      {messages.map((message) => {
        const busy = busyId === message.messageId;
        const deadline = retentionDeadline(message);
        const addresses = message.aliasIds.map((id) => aliasAddresses.get(id) ?? id).join(", ");
        return (
          <li key={message.messageId} className="message-row">
            <div className="message-main">
              <span className="message-sender">{senderLabel(message)}</span>
              <span className="message-subject">{subjectLabel(message)}</span>
            </div>
            <div className="message-meta">
              <span className="alias-value">
                Received {formatRelativeTime(message.receivedAt, now)}
              </span>
              <span className="muted">{formatExact(message.receivedAt)}</span>
              <span className="muted">
                {deadline === null
                  ? "No retention deadline"
                  : `Removed after ${formatExact(deadline)}`}
              </span>
              <span className="muted">To: {addresses}</span>
              <span className={`badge badge-status-${message.status}`}>{message.status}</span>
            </div>
            <div className="row-actions">
              {message.status === "quarantined" ? (
                <>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => onRecover(message)}
                  >
                    Recover
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => onRecoverAndRenew(message)}
                  >
                    Recover and renew
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => onReply(message)}
              >
                Reply
              </button>
              {message.status === "quarantined" ? (
                <button
                  type="button"
                  className="button button-danger"
                  disabled={busy}
                  onClick={() => onDelete(message)}
                >
                  Delete
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
