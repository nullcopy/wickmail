# End-to-end mail integration harness.
#
# Runs Postfix, Rspamd, Dovecot, and wickmail-server together and drives the
# real inbound path: RCPT policy rejection, active delivery to Inbox, expiry
# routing to the isolated quarantine mailbox, temporary failure while the
# policy service is down, and stripping of spoofed X-Wickmail-* headers.
{ pkgs, wickmailModule }:

let
  e2e = pkgs.writeScriptBin "wickmail-e2e" ''
    #!${pkgs.python3.interpreter}
    import imaplib
    import json
    import smtplib
    import subprocess
    import sys
    import time

    DOMAIN = "wickmail.test"
    DB = "/var/lib/wickmail/wickmail.sqlite"
    PRIMARY = "user@wickmail.test"
    PASSWORD = "secret"
    MAILDIR = "/var/vmail/Maildir"
    QUARANTINE = "/var/vmail/quarantine/.Expired"
    SERVER = "127.0.0.1"


    def run(*args):
        result = subprocess.run(args, capture_output=True, text=True)
        if result.returncode != 0:
            raise AssertionError(f"{args} failed: {result.stderr}")
        return result.stdout


    def create_alias(local, *extra):
        output = run(
            "wickmail-server", "create-alias",
            "--db", DB, "--domain", DOMAIN, "--local-part", local, *extra,
        )
        return json.loads(output)


    def smtp(recipient, message, sender="sender@example.net"):
        client = smtplib.SMTP(SERVER, 25, timeout=60)
        try:
            client.ehlo(DOMAIN)
            mail_code, _ = client.mail(sender)
            assert mail_code == 250, f"MAIL FROM rejected: {mail_code}"
            rcpt_code, rcpt_text = client.rcpt(recipient)
            if rcpt_code >= 400:
                return rcpt_code, rcpt_text, None
            data_code, _ = client.data(message)
            return rcpt_code, rcpt_text, data_code
        finally:
            try:
                client.quit()
            except Exception:
                pass


    def imap():
        client = imaplib.IMAP4(SERVER, 143)
        client.login(PRIMARY, PASSWORD)
        return client


    def inbox_ids(client):
        client.select("Inbox")
        status, data = client.search(None, "ALL")
        assert status == "OK"
        return data[0].split()


    def wait_for_inbox(count, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            client = imap()
            try:
                ids = inbox_ids(client)
                if len(ids) >= count:
                    return
            finally:
                client.logout()
            time.sleep(0.5)
        raise AssertionError(f"expected at least {count} messages in Inbox")


    def message_headers(message_id):
        client = imap()
        try:
            client.select("Inbox")
            status, data = client.fetch(message_id, "(BODY[HEADER])")
            assert status == "OK"
            return data[0][1].decode("utf-8", "replace")
        finally:
            client.logout()


    def quarantine_list():
        output = run(
            "wickmail-server", "mail-store", "quarantine",
            "--maildir", MAILDIR, "--quarantine-dir", QUARANTINE,
        )
        return [line.split()[0] for line in output.splitlines() if line.strip()]


    def quarantine_message(message_id):
        return run(
            "wickmail-server", "mail-store", "read",
            "--maildir", MAILDIR, "--quarantine-dir", QUARANTINE,
            "--mailbox", "Aliases/Expired", "--message-id", message_id,
        )


    def step(name):
        print(f"=== {name}", flush=True)


    step("create aliases")
    active = create_alias("green.farm", "--lease", "86400")
    expired = create_alias("old.farm", "--expires-at", "2020-01-01T00:00:00Z")
    disabled = create_alias("off.farm", "--lease", "86400", "--disable")
    active_addr = active["address"]
    expired_addr = expired["address"]
    disabled_addr = disabled["address"]
    print(f"active={active_addr} expired={expired_addr} disabled={disabled_addr}", flush=True)

    step("unknown and disabled recipients are rejected at RCPT")
    code, text, _ = smtp("nobody@" + DOMAIN, "Subject: x\r\n\r\nbody\r\n")
    assert code == 550, f"unknown recipient: {code} {text}"
    code, text, _ = smtp(disabled_addr, "Subject: x\r\n\r\nbody\r\n")
    assert code == 550, f"disabled recipient: {code} {text}"

    step("active alias delivers to Inbox")
    code, text, data_code = smtp(
        active_addr,
        "From: sender@example.net\r\nTo: " + active_addr + "\r\nSubject: active\r\n\r\nhello\r\n",
    )
    assert code == 250, f"active RCPT: {code} {text}"
    assert data_code == 250, f"active DATA: {data_code}"
    wait_for_inbox(1)
    client = imap()
    try:
        ids = inbox_ids(client)
        headers = message_headers(ids[-1])
        assert "X-Wickmail-Route: Inbox" in headers, headers
        assert "X-Wickmail-Message-ID: " in headers, headers
        assert "X-Wickmail-Alias-ID: " in headers, headers
        assert "X-Wickmail-Received-At: " in headers, headers
    finally:
        client.logout()

    step("quarantine mailbox is outside the user's IMAP namespace")
    client = imap()
    try:
        status, boxes = client.list()
        listing = b"\n".join(boxes or [])
        assert b"Aliases" not in listing, listing
    finally:
        client.logout()

    step("expired alias routes to Aliases/Expired")
    before = quarantine_list()
    code, text, data_code = smtp(
        expired_addr,
        "From: sender@example.net\r\nTo: " + expired_addr + "\r\nSubject: expired\r\n\r\nbody\r\n",
    )
    assert code == 250, f"expired RCPT: {code} {text}"
    assert data_code == 250, f"expired DATA: {data_code}"
    deadline = time.time() + 60
    while time.time() < deadline and len(quarantine_list()) <= len(before):
        time.sleep(0.5)
    after = quarantine_list()
    assert len(after) > len(before), "expired message was not quarantined"
    quarantined = after[0]
    body = quarantine_message(quarantined)
    assert "X-Wickmail-Route: Quarantine" in body, body
    # The quarantined message is not in the inbox.
    client = imap()
    try:
        assert len(inbox_ids(client)) == 1
    finally:
        client.logout()

    step("spoofed X-Wickmail-* headers are stripped and replaced")
    code, text, data_code = smtp(
        active_addr,
        "X-Wickmail-Route: Quarantine\r\n"
        "X-Wickmail-Alias-ID: 018f9b60-0000-7000-8000-0000000000ff\r\n"
        "From: sender@example.net\r\nTo: " + active_addr + "\r\nSubject: spoof\r\n\r\nbody\r\n",
    )
    assert code == 250, f"spoof RCPT: {code} {text}"
    assert data_code == 250, f"spoof DATA: {data_code}"
    wait_for_inbox(2)
    client = imap()
    try:
        ids = inbox_ids(client)
        headers = message_headers(ids[-1])
        assert "X-Wickmail-Route: Inbox" in headers, headers
        assert "Quarantine" not in headers, headers
        assert "0000000000ff" not in headers, headers
    finally:
        client.logout()

    step("policy service down returns a temporary failure")
    run("systemctl", "stop", "wickmail.service")
    time.sleep(2)
    code, text, _ = smtp(active_addr, "Subject: down\r\n\r\nbody\r\n")
    assert code == 451, f"expected 451 while policy is down, got {code} {text}"
    run("systemctl", "start", "wickmail.service")
    deadline = time.time() + 30
    while time.time() < deadline:
        status = subprocess.run(
            ["systemctl", "is-active", "wickmail.service"], capture_output=True, text=True
        ).stdout.strip()
        if status == "active":
            break
        time.sleep(0.5)
    else:
        raise AssertionError("wickmail.service did not restart")

    step("all checks passed")
  '';
in
pkgs.testers.nixosTest {
  name = "wickmail-mail-path";

  nodes.machine = {
    imports = [ wickmailModule ];
    services.wickmail = {
      enable = true;
      domain = "wickmail.test";
      primaryAddress = "user@wickmail.test";
      mailPassword = "secret";
    };
    environment.systemPackages = [
      pkgs.python3
      e2e
    ];
    virtualisation.memorySize = 2048;
    networking.hostName = "mail";
  };

  testScript = ''
    machine.wait_for_unit("dovecot.service")
    machine.wait_for_unit("rspamd.service")
    machine.wait_for_unit("wickmail.service")
    machine.wait_for_unit("postfix.service")
    machine.succeed("wickmail-e2e")
  '';
}
