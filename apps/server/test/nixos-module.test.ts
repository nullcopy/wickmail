import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE_PATH = fileURLToPath(
  new URL("../../../infra/nixos/wickmail-mail.nix", import.meta.url),
);
const TEST_CONFIG_PATH = fileURLToPath(
  new URL("../../../infra/nixos/test-configuration.nix", import.meta.url),
);
const FLAKE_PATH = fileURLToPath(new URL("../../../flake.nix", import.meta.url));

const moduleSource = readFileSync(MODULE_PATH, "utf8");

describe("NixOS mail module", () => {
  it("declares the mail path options", () => {
    for (const option of [
      "enable",
      "domain",
      "hostname",
      "primaryAddresses",
      "policySocket",
      "lmtpSocket",
      "spoolDirectory",
      "mailDirectory",
      "quarantineDirectory",
      "messageSizeLimit",
      "spam",
      "sieveScript",
      "serverPackage",
    ]) {
      expect(moduleSource).toContain(option);
    }
    expect(moduleSource).toContain("options.services.wickmail.mail");
  });

  it("wires Postfix for RCPT lookup and LMTP delivery", () => {
    expect(moduleSource).toContain("services.postfix");
    expect(moduleSource).toContain(
      "check_recipient_access socketmap:unix:${cfg.policySocket}:recipient",
    );
    expect(moduleSource).toContain('virtual_transport = "lmtp:unix:${cfg.lmtpSocket}"');
  });

  it("runs Rspamd before the proxy", () => {
    expect(moduleSource).toContain("services.rspamd");
    expect(moduleSource).toContain("postfix.enable = true");
  });

  it("configures Dovecot LMTP, IMAP, and the isolated quarantine namespace", () => {
    expect(moduleSource).toContain("services.dovecot2");
    expect(moduleSource).toContain("lmtp = true");
    expect(moduleSource).toContain("imap = true");
    expect(moduleSource).toContain('"namespace quarantine"');
    expect(moduleSource).toContain("hidden = true");
    expect(moduleSource).toContain("sieveScript");
  });

  it("ships the global Sieve script as the module default", () => {
    expect(moduleSource).toContain("../../infra/dovecot/wickmail.sieve");
  });
});

describe("flake mail module wiring", () => {
  it("exports the NixOS module and evaluates a sample configuration", () => {
    const flake = readFileSync(FLAKE_PATH, "utf8");
    expect(flake).toContain("nixosModules");
    expect(flake).toContain("infra/nixos/wickmail-mail.nix");
    expect(flake).toContain("nixos-modules");
    expect(flake).toContain("infra/nixos/test-configuration.nix");
  });

  it("provides a sample configuration that enables the module", () => {
    const testConfig = readFileSync(TEST_CONFIG_PATH, "utf8");
    expect(testConfig).toContain("services.wickmail.mail");
    expect(testConfig).toContain("enable = true");
  });
});
