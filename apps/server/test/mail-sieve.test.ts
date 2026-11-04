import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderGlobalSieveScript, routeToMailbox } from "../src/mail/sieve.js";

const SIEVE_PATH = fileURLToPath(new URL("../../../infra/dovecot/wickmail.sieve", import.meta.url));

describe("global Sieve script", () => {
  it("is checked in and matches the generated script", () => {
    const checkedIn = readFileSync(SIEVE_PATH, "utf8");
    expect(checkedIn).toBe(renderGlobalSieveScript());
  });

  it("routes on the trusted X-Wickmail-Route header", () => {
    const script = renderGlobalSieveScript();
    expect(script).toContain('header :contains "X-Wickmail-Route" "Spam"');
    expect(script).toContain('header :contains "X-Wickmail-Route" "Aliases/Expired"');
    expect(script).toContain('fileinto :create "Inbox"');
  });

  it("checks spam before alias state so spam wins", () => {
    const script = renderGlobalSieveScript();
    expect(script.indexOf('"Spam"')).toBeLessThan(script.indexOf('"Aliases/Expired"'));
  });

  it("files the quarantine route into the isolated mailbox", () => {
    expect(routeToMailbox("Aliases/Expired")).toBe("Aliases/Expired");
    expect(routeToMailbox("Inbox")).toBe("Inbox");
    expect(routeToMailbox("Spam")).toBe("Spam");
  });
});
