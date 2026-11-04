/** Label key/value pairs attached to a metric sample. */
export type MetricLabels = Record<string, string>;

/** The kind of a metric family, following Prometheus conventions. */
export type MetricType = "counter" | "gauge";

/** One labelled sample within a metric family. */
export interface MetricSample {
  labels: MetricLabels;
  value: number;
}

interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: Map<string, MetricSample>;
}

/** A stable key for a label set, independent of key order. */
function labelKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name]}`)
    .join(",");
}

/** Escape a Prometheus label value. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Render a label set in Prometheus exposition syntax. */
function formatLabels(labels: MetricLabels): string {
  const names = Object.keys(labels).sort();
  if (names.length === 0) {
    return "";
  }
  const pairs = names.map((name) => `${name}="${escapeLabelValue(labels[name]!)}"`);
  return `{${pairs.join(",")}}`;
}

/** Render a sample value, including the Prometheus spellings of the non-finite values. */
function formatValue(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (value === Number.POSITIVE_INFINITY) {
    return "+Inf";
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return "-Inf";
  }
  return String(value);
}

/**
 * An in-process metrics registry that renders the Prometheus text exposition
 * format.
 *
 * Counters only increase; gauges hold the latest observed value. A family's
 * help text and type are fixed by its first use, so callers pass the same help
 * string on every update. State is in-process, which matches the single-process
 * v1 deployment and the pull-based scrape model.
 */
export class MetricsRegistry {
  private readonly families = new Map<string, MetricFamily>();

  private family(name: string, help: string, type: MetricType): MetricFamily {
    const existing = this.families.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const family: MetricFamily = { name, help, type, samples: new Map() };
    this.families.set(name, family);
    return family;
  }

  /** Add `amount` to a counter sample. */
  increment(name: string, help: string, labels: MetricLabels = {}, amount = 1): void {
    const family = this.family(name, help, "counter");
    const key = labelKey(labels);
    const sample = family.samples.get(key) ?? { labels, value: 0 };
    sample.value += amount;
    family.samples.set(key, sample);
  }

  /** Set a gauge sample to `value`. */
  set(name: string, help: string, value: number, labels: MetricLabels = {}): void {
    const family = this.family(name, help, "gauge");
    family.samples.set(labelKey(labels), { labels, value });
  }

  /** The current value of a sample, or zero when it has never been set. */
  get(name: string, labels: MetricLabels = {}): number {
    return this.families.get(name)?.samples.get(labelKey(labels))?.value ?? 0;
  }

  /** Every sample of a family, sorted by label key. For tests and diagnostics. */
  samples(name: string): MetricSample[] {
    const family = this.families.get(name);
    if (family === undefined) {
      return [];
    }
    return [...family.samples.values()].sort((left, right) =>
      labelKey(left.labels).localeCompare(labelKey(right.labels)),
    );
  }

  /** Drop all families. */
  reset(): void {
    this.families.clear();
  }

  /** Render every family in the Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const name of [...this.families.keys()].sort()) {
      const family = this.families.get(name)!;
      lines.push(`# HELP ${name} ${family.help}`);
      lines.push(`# TYPE ${name} ${family.type}`);
      const samples = [...family.samples.values()].sort((left, right) =>
        labelKey(left.labels).localeCompare(labelKey(right.labels)),
      );
      for (const sample of samples) {
        lines.push(`${name}${formatLabels(sample.labels)} ${formatValue(sample.value)}`);
      }
    }
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }
}
