/**
 * Promise-based confirmation for destructive actions.
 *
 * `ask` opens the dialog and resolves once the user confirms or cancels.
 */

/** Options for a confirmation prompt. */
export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

class ConfirmStore {
  options = $state<ConfirmOptions | null>(null);
  #resolve: ((value: boolean) => void) | null = null;

  /** Opens the dialog and resolves with the user's choice. */
  ask(options: ConfirmOptions): Promise<boolean> {
    this.options = options;
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  /** Resolves the open dialog. */
  respond(value: boolean): void {
    const resolve = this.#resolve;
    this.#resolve = null;
    this.options = null;
    resolve?.(value);
  }
}

export const confirm = new ConfirmStore();
