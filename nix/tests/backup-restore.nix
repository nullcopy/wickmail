# Backup, restore, and reconciliation drill.
#
# Boots the full mail path, delivers a message to an active alias and one to
# an expired alias, backs up the database and mail store, simulates loss,
# restores the backup, and verifies that reconciliation repairs the mail
# store and that the account and messages survived.
{ pkgs, wickmailModule }:

let
  drill = pkgs.writeScriptBin "wickmail-backup-drill" ''
    #!${pkgs.python3.interpreter}
    import glob
    import imaplib
    import json
    import os
    import shutil
    import smtplib
    import subprocess
    import time

    DOMAIN = "wickmail.test"
    DB = "/var/lib/wickmail/wickmail.sqlite"
    PRIMARY = "user@wickmail.test"
    PASSWORD = "secret"
    MAILDIR = "/var/vmail/Maildir"
    QUARANTINE = "/var/vmail/quarantine/.Expired"
    BACKUP_DIR = "/tmp/wickmail-backup"
    SERVER = "127.0.0.1"


    def run(*args, check=True):
        result = subprocess.run(args, capture_output=True, text=True)
        if check and result.returncode != 0:
            raise AssertionError(f"{args} failed: {result.stderr}{result.stdout}")
        return result


    def create_alias(local, *extra):
        output = run(
            "wickmail-server", "create-alias",
            "--db", DB, "--domain", DOMAIN, "--local-part", local, *extra,
        ).stdout
        return json.loads(output)


    def smtp(recipient, message, sender="sender@example.net"):
        client = smtplib.SMTP(SERVER, 25, timeout=60)
        try:
            client.ehlo(DOMAIN)
            client.mail(sender)
            code, text = client.rcpt(recipient)
            if code >= 400:
                return code, text
            data_code, _ = client.data(message)
            return code, data_code
        finally:
            try:
                client.quit()
            except Exception:
                pass


    def wait_active(unit, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            status = subprocess.run(
                ["systemctl", "is-active", unit], capture_output=True, text=True
            ).stdout.strip()
            if status == "active":
                return
            time.sleep(0.5)
        raise AssertionError(f"{unit} did not become active")


    def inbox_count():
        client = imaplib.IMAP4(SERVER, 143)
        client.login(PRIMARY, PASSWORD)
        try:
            client.select("Inbox")
            status, data = client.search(None, "ALL")
            assert status == "OK"
            return len(data[0].split())
        finally:
            client.logout()


    def wait_for_inbox(count, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if inbox_count() >= count:
                    return
            except Exception:
                pass
            time.sleep(0.5)
        raise AssertionError(f"expected at least {count} messages in Inbox")


    def quarantine_list():
        output = run(
            "wickmail-server", "mail-store", "quarantine",
            "--maildir", MAILDIR, "--quarantine-dir", QUARANTINE,
        ).stdout
        return [line.split()[0] for line in output.splitlines() if line.strip()]


    def step(name):
        print(f"=== {name}", flush=True)


    step("create aliases and deliver mail")
    active = create_alias("green.farm", "--lease", "86400")
    expired = create_alias("old.farm", "--expires-at", "2020-01-01T00:00:00Z")
    code, data_code = smtp(
        active["address"],
        "From: sender@example.net\r\nTo: " + active["address"] + "\r\nSubject: active\r\n\r\nhi\r\n",
    )
    assert code == 250 and data_code == 250, f"active delivery failed: {code}/{data_code}"
    wait_for_inbox(1)
    code, data_code = smtp(
        expired["address"],
        "From: sender@example.net\r\nTo: " + expired["address"] + "\r\nSubject: expired\r\n\r\nhi\r\n",
    )
    assert code == 250 and data_code == 250, f"expired delivery failed: {code}/{data_code}"
    deadline = time.time() + 60
    while time.time() < deadline and not quarantine_list():
        time.sleep(0.5)
    assert quarantine_list(), "expired message was not quarantined"

    step("back up the database and mail store")
    run(
        "wickmail-backup", "--state-dir", "/var/lib/wickmail",
        "--mail-root", "/var/vmail", "--output", BACKUP_DIR, "--retention", "0",
    )
    archives = glob.glob(os.path.join(BACKUP_DIR, "wickmail-backup-*.tar.gz"))
    assert len(archives) == 1, f"expected one archive, found {archives}"
    archive = archives[0]
    assert os.path.exists(archive + ".sha256"), "checksum sidecar missing"

    step("simulate loss of the database and mail store")
    run("systemctl", "stop", "wickmail.service", "dovecot.service", "postfix.service")
    shutil.rmtree(MAILDIR, ignore_errors=True)
    shutil.rmtree("/var/vmail/quarantine", ignore_errors=True)
    for suffix in ["", "-wal", "-shm"]:
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass
    assert not os.path.exists(DB), "database was not removed"

    step("restore and reconcile")
    run(
        "wickmail-restore", "--archive", archive,
        "--state-dir", "/var/lib/wickmail", "--mail-root", "/var/vmail",
        "--force", "--reconcile",
    )
    assert os.path.exists(DB), "restore did not recreate the database"

    step("reconciliation repairs a missing quarantine body")
    # Remove the quarantined body but keep the metadata: reconciliation must
    # mark it deleted rather than fail.
    for sub in ["cur", "new"]:
        directory = os.path.join(QUARANTINE, sub)
        if os.path.isdir(directory):
            for name in os.listdir(directory):
                os.remove(os.path.join(directory, name))
    report = run(
        "wickmail-server", "quarantine", "reconcile",
        "--db", DB, "--maildir", MAILDIR, "--quarantine-dir", QUARANTINE,
    ).stdout
    print(f"reconcile: {report.strip()}", flush=True)
    assert "deleted=1" in report, f"reconciliation did not repair the missing body: {report}"

    step("start services and verify the account and inbox survived")
    run("systemctl", "start", "dovecot.service", "postfix.service", "wickmail.service")
    wait_active("dovecot.service")
    wait_active("wickmail.service")
    wait_active("postfix.service")
    wait_for_inbox(1)

    step("the restored alias database still serves the active alias")
    code, data_code = smtp(
        active["address"],
        "From: sender@example.net\r\nTo: " + active["address"] + "\r\nSubject: after-restore\r\n\r\nhi\r\n",
    )
    assert code == 250 and data_code == 250, f"alias lookup after restore failed: {code}/{data_code}"
    wait_for_inbox(2)

    step("all checks passed")
  '';
in
pkgs.testers.nixosTest {
  name = "wickmail-backup-restore";

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
      drill
    ];
    virtualisation.memorySize = 2048;
    networking.hostName = "mail";
  };

  testScript = ''
    machine.wait_for_unit("dovecot.service")
    machine.wait_for_unit("rspamd.service")
    machine.wait_for_unit("wickmail.service")
    machine.wait_for_unit("postfix.service")
    machine.succeed("wickmail-backup-drill")
  '';
}
