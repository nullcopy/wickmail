import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

/** A parsed TLS certificate's expiry, relative to a reference time. */
export interface CertificateExpiry {
  /** The certificate file the value came from. */
  path: string;
  /** The not-after time in epoch milliseconds. */
  notAfter: number;
  /** Whole seconds until expiry; negative once expired. */
  secondsRemaining: number;
}

/**
 * Read a PEM certificate and report when it expires. An unreadable or invalid
 * file is reported as `undefined` rather than throwing, so a missing
 * certificate never breaks the scrape.
 */
export function certificateExpiry(path: string, now: number): CertificateExpiry | undefined {
  try {
    const pem = readFileSync(path, "utf8");
    const certificate = new X509Certificate(pem);
    const notAfter = certificateNotAfter(certificate);
    if (notAfter === undefined) {
      return undefined;
    }
    return { path, notAfter, secondsRemaining: Math.floor((notAfter - now) / 1000) };
  } catch {
    return undefined;
  }
}

function certificateNotAfter(certificate: X509Certificate): number | undefined {
  // Node 19+ exposes `validToDate`; older versions only expose the string.
  const withDate = certificate as X509Certificate & { validToDate?: Date };
  const notAfter = withDate.validToDate?.getTime() ?? Date.parse(certificate.validTo);
  return Number.isNaN(notAfter) ? undefined : notAfter;
}
