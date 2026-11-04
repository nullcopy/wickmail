import { useCallback, useState } from "react";
import type { QuarantinedMessage } from "wickmail-core";
import { useApi } from "../api/context.js";
import { describeError } from "../lib/errors.js";
import { navigate } from "../lib/router.js";

/** A transient status message. */
export interface ActionStatus {
  tone: "success" | "error" | "info";
  message: string;
}

/** The quarantine action state shared by the quarantine, messages, and detail screens. */
export interface QuarantineActions {
  busyId: string | null;
  status: ActionStatus | null;
  confirmDelete: QuarantinedMessage | null;
  replyPrompt: QuarantinedMessage | null;
  recover: (message: QuarantinedMessage) => Promise<void>;
  recoverAndRenew: (message: QuarantinedMessage) => Promise<void>;
  requestDelete: (message: QuarantinedMessage) => void;
  cancelDelete: () => void;
  confirmDeleteNow: () => Promise<void>;
  requestReply: (message: QuarantinedMessage) => void;
  cancelReply: () => void;
  confirmReply: () => Promise<void>;
}

/**
 * Drive quarantine recovery, deletion, and reply gating.
 *
 * A reply to a quarantined message prompts to recover and renew the alias
 * first; the composer only opens once that succeeds.
 */
export function useQuarantineActions(onChanged: () => void): QuarantineActions {
  const { client } = useApi();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<QuarantinedMessage | null>(null);
  const [replyPrompt, setReplyPrompt] = useState<QuarantinedMessage | null>(null);

  const recover = useCallback(
    async (message: QuarantinedMessage, renew: boolean): Promise<void> => {
      setBusyId(message.messageId);
      setStatus(null);
      try {
        const result = await client.recoverQuarantine(
          message.messageId,
          renew ? { renew: true } : {},
        );
        setStatus({
          tone: "success",
          message:
            result.status === "already_recovered"
              ? "This message was already recovered."
              : renew
                ? "Recovered the message and renewed the alias."
                : "Recovered the message to the inbox.",
        });
        onChanged();
      } catch (error) {
        setStatus({ tone: "error", message: describeError(error).message });
      } finally {
        setBusyId(null);
      }
    },
    [client, onChanged],
  );

  return {
    busyId,
    status,
    confirmDelete,
    replyPrompt,
    recover: (message) => recover(message, false),
    recoverAndRenew: (message) => recover(message, true),
    requestDelete: (message) => setConfirmDelete(message),
    cancelDelete: () => setConfirmDelete(null),
    confirmDeleteNow: async () => {
      const message = confirmDelete;
      if (message === null) {
        return;
      }
      setBusyId(message.messageId);
      setStatus(null);
      try {
        const result = await client.deleteQuarantine(message.messageId, {
          reason: "user_requested",
        });
        setStatus({
          tone: "success",
          message:
            result.status === "already_deleted"
              ? "This message was already deleted."
              : "Deleted the quarantined message.",
        });
        setConfirmDelete(null);
        onChanged();
      } catch (error) {
        setStatus({ tone: "error", message: describeError(error).message });
      } finally {
        setBusyId(null);
      }
    },
    requestReply: (message) => {
      if (message.status === "quarantined") {
        setReplyPrompt(message);
      } else {
        navigate({ name: "composer", id: message.messageId });
      }
    },
    cancelReply: () => setReplyPrompt(null),
    confirmReply: async () => {
      const message = replyPrompt;
      if (message === null) {
        return;
      }
      setBusyId(message.messageId);
      setStatus(null);
      try {
        await client.recoverQuarantine(message.messageId, { renew: true });
        setReplyPrompt(null);
        onChanged();
        navigate({ name: "composer", id: message.messageId });
      } catch (error) {
        setStatus({ tone: "error", message: describeError(error).message });
      } finally {
        setBusyId(null);
      }
    },
  };
}
