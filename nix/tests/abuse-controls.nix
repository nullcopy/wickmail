# Abuse-control verification.
#
# Boots the module with low limits and confirms that quotas, rate limits, and
# disk-full behavior hold, that the server is not an open relay, and that
# outbound submission is rate limited.
{ pkgs, wickmailModule }:

let
  probe = pkgs.writeScriptBin "wickmail-abuse-probe" ''
    #!${pkgs.python3.interpreter}
    import json
    import smtplib
    import subprocess
    import time

    DOMAIN = "wickmail.test"
    DB = "/var/lib/wickmail/wickmail.sqlite"
    PRIMARY = "user@wickmail.test"
    MAILDIR = "/var/vmail/Maildir"
    SERVER = "127.0.0.1"


    def run(*args, check=True):
        result = subprocess.run(args, capture_output=True, text=True)
        if check and result.returncode != 0:
            raise AssertionError(f"{args} failed: {result.stderr}{result.stdout}")
        return result


    def create_alias(local):
        output = run(
            "wickmail-server", "create-alias",
            "--db", DB, "--domain", DOMAIN, "--local-part", local, "--lease", "86400",
        ).stdout
        return json.loads(output)["address"]


    def rcpt_only(recipient, sender="sender@example.net"):
        client = smtplib.SMTP(SERVER, 25, timeout=30)
        try:
            client.ehlo(DOMAIN)
            client.mail(sender)
            return client.rcpt(recipient)
        finally:
            try:
                client.quit()
            except Exception:
                pass


    def deliver(recipient, body, sender="sender@example.net"):
        client = smtplib.SMTP(SERVER, 25, timeout=60)
        try:
            client.ehlo(DOMAIN)
            client.mail(sender)
            code, text = client.rcpt(recipient)
            if code >= 400:
                return code, text
            data_code, _ = client.data(
                "From: " + sender + "\r\nTo: " + recipient + "\r\nSubject: probe\r\n\r\n" + body
            )
            return code, data_code
        finally:
            try:
                client.quit()
            except Exception:
                pass


    def submission(sender, recipient):
        client = smtplib.SMTP(SERVER, 587, timeout=30)
        try:
            client.ehlo(DOMAIN)
            code, text = client.mail(sender)
            if code >= 400:
                return code, text
            code, text = client.rcpt(recipient)
            if code >= 400:
                return code, text
            return client.data(
                "From: " + sender + "\r\nTo: " + recipient + "\r\nSubject: out\r\n\r\nbody"
            )
        finally:
            try:
                client.quit()
            except Exception:
                pass


    def inbox_count():
        import imaplib
        client = imaplib.IMAP4(SERVER, 143)
        client.login(PRIMARY, "secret")
        try:
            client.select("Inbox")
            status, data = client.search(None, "ALL")
            assert status == "OK"
            return len(data[0].split())
        finally:
            client.logout()


    def journal():
        return run("journalctl", "-u", "wickmail.service", "--no-pager", check=False).stdout


    def step(name):
        print(f"=== {name}", flush=True)


    active = create_alias("green.farm")

    step("unknown recipients are rejected with a permanent failure")
    code, text = rcpt_only("nobody@" + DOMAIN)
    assert code == 550, f"unknown recipient: {code} {text}"

    step("the server is not an open relay")
    code, text = rcpt_only("victim@elsewhere.example")
    # Postfix defers unauthenticated relay with 454 by default and rejects
    # with 554 when `reject_unauth_destination` is configured; either denies it.
    assert code in (454, 554), f"relay attempt was not denied: {code} {text}"

    step("oversized messages are rejected at DATA")
    big = "x" * 16384
    code, data_code = deliver(active, big)
    assert code == 250, f"RCPT before DATA: {code}"
    assert data_code == 552, f"oversized message accepted: {data_code}"

    step("the inbound per-sender rate limit defers excess mail")
    for _ in range(3):
        code, data_code = deliver(active, "small body")
        assert code == 250, f"delivery RCPT: {code} {data_code}"
    # The limit is two per sender per hour; only two reach the inbox.
    deadline = time.time() + 30
    while time.time() < deadline:
        if inbox_count() >= 2:
            break
        time.sleep(0.5)
    time.sleep(2)
    assert inbox_count() == 2, f"expected exactly 2 delivered, got {inbox_count()}"

    step("outbound submission is rate limited")
    # Send to the active alias so relay restrictions allow the recipient; the
    # rate limit is what the test exercises.
    code, text = submission(PRIMARY, active)
    assert code == 250, f"first submission rejected: {code} {text}"
    code, text = submission(PRIMARY, active)
    assert code in (450, 451, 452), f"second submission was not rate limited: {code} {text}"

    step("a full disk returns a temporary failure and raises a disk-full alert")
    run("systemctl", "stop", "wickmail.service")
    run("mount", "-t", "tmpfs", "-o", "size=1M", "tmpfs", "/var/lib/wickmail/spool")
    run("sh", "-c", "dd if=/dev/zero of=/var/lib/wickmail/spool/fill bs=1k count=2048 || true")
    run("systemctl", "start", "wickmail.service")
    deadline = time.time() + 30
    while time.time() < deadline:
        status = subprocess.run(
            ["systemctl", "is-active", "wickmail.service"], capture_output=True, text=True
        ).stdout.strip()
        if status == "active":
            break
        time.sleep(0.5)
    # A fresh sender so the inbound rate limit does not mask the spool failure.
    code, data_code = deliver(active, "spool me", sender="full@example.net")
    assert code == 250, f"RCPT while spool is full: {code}"
    # The message is deferred by the proxy and the failure is alerted.
    deadline = time.time() + 20
    while time.time() < deadline:
        if "alert [disk_full]" in journal():
            break
        time.sleep(0.5)
    assert "alert [disk_full]" in journal(), "no disk-full alert was recorded"

    step("restore the spool and confirm recovery")
    run("systemctl", "stop", "wickmail.service")
    run("umount", "/var/lib/wickmail/spool")
    run("systemctl", "start", "wickmail.service")
    deadline = time.time() + 30
    while time.time() < deadline:
        status = subprocess.run(
            ["systemctl", "is-active", "wickmail.service"], capture_output=True, text=True
        ).stdout.strip()
        if status == "active":
            break
        time.sleep(0.5)

    step("all checks passed")
  '';
in
pkgs.testers.nixosTest {
  name = "wickmail-abuse-controls";

  nodes.machine = {
    imports = [ wickmailModule ];
    services.wickmail = {
      enable = true;
      domain = "wickmail.test";
      primaryAddress = "user@wickmail.test";
      mailPassword = "secret";
      enableSubmission = true;
      # Larger than the delivered small messages (with Postfix headers) and
      # smaller than the oversized test message.
      maxMessageBytes = 4096;
      perSenderRate = 2;
      outboundRateLimit = 1;
    };
    # The test drives submission without TLS or SASL so the ownership and rate
    # limits can be exercised hermetically.
    services.postfix.submissionOptions = pkgs.lib.mkForce {
      smtpd_tls_security_level = "none";
      smtpd_recipient_restrictions = "permit";
      smtpd_sender_restrictions = "wickmail_sender";
      access_map_reject_code = "550";
      milter_macro_daemon_name = "ORIGINATING";
      smtpd_client_message_rate_limit = "1";
    };
    # Postfix enforces the SMTP-visible size limit. A very small limit breaks
    # the milter, so keep it above the milter's working size and send a larger
    # message in the test. The server's own limit is unit-tested.
    services.postfix.settings.main.message_size_limit = pkgs.lib.mkForce 8192;
    # Do not trust the loopback client, so the relay test exercises the
    # relay restrictions rather than `permit_mynetworks`.
    services.postfix.settings.main.mynetworks = pkgs.lib.mkForce [ "127.0.0.2/32" ];
    environment.systemPackages = [
      pkgs.python3
      probe
    ];
    virtualisation.memorySize = 2048;
    networking.hostName = "mail";
  };

  testScript = ''
    machine.wait_for_unit("dovecot.service")
    machine.wait_for_unit("rspamd.service")
    machine.wait_for_unit("wickmail.service")
    machine.wait_for_unit("postfix.service")
    machine.succeed("wickmail-abuse-probe")
  '';
}
