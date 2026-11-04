# Scheduled backups for Wickmail.
#
# This module installs a systemd service and timer that run
# infra/scripts/backup.sh, which snapshots the SQLite database with SQLite's
# online backup command and archives the mail store, quarantine, spool, and
# configuration. Restoration is deliberately manual and documented in
# docs/operations/backup.md; a restore is a recovery action, not a routine.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.wickmail.backup;
  inherit (lib) mkIf mkOption mkEnableOption types;
in
{
  options.services.wickmail.backup = {
    enable = mkEnableOption "scheduled Wickmail backups";

    databasePath = mkOption {
      type = types.path;
      default = "/var/lib/wickmail/wickmail.db";
      description = "SQLite database file to back up.";
    };

    mailDirectory = mkOption {
      type = types.path;
      default = "/var/vmail";
      description = "Dovecot mail root to back up.";
    };

    quarantineDirectory = mkOption {
      type = types.path;
      default = "/var/vmail-quarantine";
      description = "Isolated quarantine mail root to back up.";
    };

    spoolDirectory = mkOption {
      type = types.path;
      default = "/var/lib/wickmail/spool";
      description = "Durable spool directory to back up.";
    };

    configDirectory = mkOption {
      type = types.path;
      default = "/etc/wickmail";
      description = "Host configuration directory to back up.";
    };

    backupDirectory = mkOption {
      type = types.path;
      default = "/var/backups/wickmail";
      description = "Directory the backup archives are written to.";
    };

    schedule = mkOption {
      type = types.str;
      default = "*-*-* 02:30:00";
      description = "systemd OnCalendar schedule for the backup timer.";
    };

    retentionDays = mkOption {
      type = types.ints.positive;
      default = 14;
      description = "Delete backup archives older than this many days.";
    };
  };

  config = mkIf cfg.enable {
    systemd.services.wickmail-backup = {
      description = "Back up the Wickmail mail store, database, and configuration";
      path = with pkgs; [
        coreutils
        gawk
        gnutar
        sqlite
      ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.bash}/bin/bash ${../scripts/backup.sh}";
        ExecStartPost = "${pkgs.findutils}/bin/find ${cfg.backupDirectory} -maxdepth 1 -name 'wickmail-backup-*' -mtime +${toString cfg.retentionDays} -delete";
        Environment = [
          "WICKMAIL_DB=${cfg.databasePath}"
          "WICKMAIL_MAIL_DIR=${cfg.mailDirectory}"
          "WICKMAIL_QUARANTINE_DIR=${cfg.quarantineDirectory}"
          "WICKMAIL_SPOOL_DIR=${cfg.spoolDirectory}"
          "WICKMAIL_CONFIG_DIR=${cfg.configDirectory}"
          "BACKUP_DIR=${cfg.backupDirectory}"
        ];
      };
    };

    systemd.timers.wickmail-backup = {
      description = "Scheduled Wickmail backup";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.schedule;
        Persistent = true;
      };
    };
  };
}
