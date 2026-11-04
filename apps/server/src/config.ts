/** Configuration for the inbound mail path. */
export interface MailPathConfig {
  /** The hostname advertised in the LMTP greeting and the policy map name. */
  hostname: string;
  /** Domains this server is authoritative for. */
  localDomains: string[];
  /** Primary addresses that are always accepted. */
  primaryAddresses: string[];
  /** The durable spool directory. */
  spoolDirectory: string;
  /** The Postfix socketmap socket path. */
  policySocketPath?: string;
  /** The LMTP listen socket path. */
  lmtpSocketPath?: string;
  /** The maximum accepted message size in bytes. */
  maxMessageBytes?: number;
}
