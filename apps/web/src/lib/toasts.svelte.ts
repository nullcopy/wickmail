/**
 * Transient status messages.
 *
 * Toasts confirm copy, renew, recover, and other actions without moving focus.
 */

/** Severity of a toast. */
export type ToastKind = "success" | "info" | "error";

/** A single toast message. */
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

class ToastStore {
  items = $state<Toast[]>([]);
  #next = 1;

  push(kind: ToastKind, message: string): number {
    const id = this.#next++;
    this.items = [...this.items, { id, kind, message }];
    setTimeout(() => this.dismiss(id), kind === "error" ? 8000 : 4000);
    return id;
  }

  success(message: string): number {
    return this.push("success", message);
  }

  info(message: string): number {
    return this.push("info", message);
  }

  error(message: string): number {
    return this.push("error", message);
  }

  dismiss(id: number): void {
    this.items = this.items.filter((toast) => toast.id !== id);
  }
}

export const toasts = new ToastStore();
