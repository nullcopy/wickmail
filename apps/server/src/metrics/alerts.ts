import type { Alert, AlertSink } from "../abuse/disk.js";
import { METRIC } from "./names.js";
import type { MetricsRegistry } from "./registry.js";

/**
 * An alert sink that counts every alert and forwards it to an inner sink.
 *
 * The existing mail-path hooks (`disk_full` from the LMTP proxy, `spool_full`
 * and quota signals from retention) already emit structured alerts; this sink
 * turns them into the `wickmail_alerts_total` counter so an operator can alert
 * on the rate of any kind without parsing logs.
 */
export class MetricsAlertSink implements AlertSink {
  constructor(
    private readonly registry: MetricsRegistry,
    private readonly inner?: AlertSink,
  ) {}

  alert(alert: Alert): void {
    this.registry.increment(METRIC.alertsTotal.name, METRIC.alertsTotal.help, {
      kind: alert.kind,
    });
    this.inner?.alert(alert);
  }
}
