import type { ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { StatusMessage } from "./ui.js";
import type { QuarantineActions } from "../hooks/useQuarantineActions.js";

/** Render the shared status message and confirmation dialogs for quarantine actions. */
export function QuarantineActionDialogs({ actions }: { actions: QuarantineActions }): ReactNode {
  return (
    <>
      {actions.status !== null ? (
        <StatusMessage tone={actions.status.tone}>{actions.status.message}</StatusMessage>
      ) : null}
      <ConfirmDialog
        open={actions.confirmDelete !== null}
        title="Delete quarantined message?"
        destructive
        confirmLabel="Delete message"
        busy={actions.busyId !== null}
        description={
          <p>
            The message and its metadata are deleted permanently. This cannot be undone. To keep the
            message, recover it instead.
          </p>
        }
        onConfirm={() => {
          void actions.confirmDeleteNow();
        }}
        onCancel={actions.cancelDelete}
      />
      <ConfirmDialog
        open={actions.replyPrompt !== null}
        title="Recover and renew before replying?"
        confirmLabel="Recover and renew"
        busy={actions.busyId !== null}
        description={
          <p>
            This message is quarantined. Replying first recovers it to the inbox and renews its
            alias so the reply is sent as an active identity.
          </p>
        }
        onConfirm={() => {
          void actions.confirmReply();
        }}
        onCancel={actions.cancelReply}
      />
    </>
  );
}
