import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  API_CONTRACT_VERSION,
  ValidationError,
  parseAlias,
  parseAliasEvent,
  parseAliasListResponse,
  parseContractVersion,
  parseCreateAliasRequest,
  parseCreateTokenRequest,
  parseDurationRequest,
  parseEnableRequest,
  parseErrorResponse,
  parseIssuedTokenResponse,
  parseMailCredentialResponse,
  parseMessage,
  parseMessageListResponse,
  parsePasskeyResponse,
  parseQuarantineListResponse,
  parseQuarantineResponse,
  parseRecoverQuarantineRequest,
  parseReplyContext,
  parseReplyRequest,
  parseReplyResponse,
  parseRotateMailCredentialResponse,
  parseSessionResponse,
  parseSetExpiryRequest,
  parseSetupRequest,
  parseTokenListResponse,
  parseUpdateAliasRequest,
  parseUserResponse,
} from "./index.ts";

// The Rust server generates these fixtures; see contract.rs. The path is
// relative to this file and is present in both the dev shell and the Nix
// build's filtered source tree.
const fixtureDir = new URL(
  "../../../apps/server/crates/wickmail-server/fixtures/",
  import.meta.url,
);

type Validator = (value: unknown) => unknown;

const validators: Record<string, Validator> = {
  "contract.json": parseContractVersion,
  "create-alias-request.json": parseCreateAliasRequest,
  "create-alias-absolute-request.json": parseCreateAliasRequest,
  "create-alias-never-request.json": parseCreateAliasRequest,
  "update-alias-request.json": parseUpdateAliasRequest,
  "duration-request.json": parseDurationRequest,
  "set-expiry-request.json": parseSetExpiryRequest,
  "enable-request.json": parseEnableRequest,
  "alias-response.json": parseAlias,
  "alias-list-response.json": parseAliasListResponse,
  "alias-event.json": parseAliasEvent,
  "message-response.json": parseMessage,
  "message-list-response.json": parseMessageListResponse,
  "error-response.json": parseErrorResponse,
  "reply-context.json": parseReplyContext,
  "reply-request.json": parseReplyRequest,
  "reply-response.json": parseReplyResponse,
  "setup-request.json": parseSetupRequest,
  "user-response.json": parseUserResponse,
  "session-response.json": parseSessionResponse,
  "create-token-request.json": parseCreateTokenRequest,
  "issued-token-response.json": parseIssuedTokenResponse,
  "token-list-response.json": parseTokenListResponse,
  "quarantine-response.json": parseQuarantineResponse,
  "quarantine-list-response.json": parseQuarantineListResponse,
  "recover-quarantine-request.json": parseRecoverQuarantineRequest,
  "mail-credential-response.json": parseMailCredentialResponse,
  "rotate-mail-credential-response.json": parseRotateMailCredentialResponse,
  "passkey-response.json": parsePasskeyResponse,
};

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8"));
}

for (const [name, validate] of Object.entries(validators)) {
  test(`server fixture ${name} matches the client schema`, () => {
    assert.doesNotThrow(() => validate(readFixture(name)));
  });
}

test("every server fixture has a client validator", () => {
  const files = readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.deepEqual(files, Object.keys(validators).sort());
});

test("client contract version matches the server fixture", () => {
  const version = parseContractVersion(readFixture("contract.json"));
  assert.equal(version.apiContractVersion, API_CONTRACT_VERSION);
});

test("unknown properties are rejected", () => {
  const raw = readFixture("alias-response.json") as Record<string, unknown>;
  assert.throws(() => parseAlias({ ...raw, unexpected: true }), ValidationError);
});

test("missing properties are rejected", () => {
  const raw = readFixture("alias-response.json") as Record<string, unknown>;
  const clone = { ...raw };
  delete clone["leaseSeconds"];
  assert.throws(() => parseAlias(clone), ValidationError);
});

test("wrong property types are rejected", () => {
  const raw = readFixture("alias-response.json") as Record<string, unknown>;
  assert.throws(() => parseAlias({ ...raw, policyVersion: "two" }), ValidationError);
});
