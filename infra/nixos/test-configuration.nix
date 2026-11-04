# A sample configuration used by `nix flake check` to evaluate the Wickmail
# NixOS module. It is not deployed; it only proves the module resolves and
# configures Postfix, Rspamd, and Dovecot.
{ ... }:

{
  services.wickmail.mail = {
    enable = true;
    domain = "example.com";
    primaryAddresses = [ "me@example.com" ];
    spam.enable = true;
  };

  # Evaluate the scheduled-backup module too; it installs a systemd timer that
  # runs infra/scripts/backup.sh.
  services.wickmail.backup = {
    enable = true;
    backupDirectory = "/var/backups/wickmail";
  };

  # A recent state version selects the Dovecot 2.4 settings interface.
  system.stateVersion = "26.05";
}
