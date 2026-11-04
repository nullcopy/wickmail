{ config, lib, pkgs, ... }:

let
  cfg = config.services.wickmail.mail;
  inherit (lib) mkIf mkOption mkEnableOption types;

  # A minimal Dovecot snippet that loads Pigeonhole and runs the global
  # Wickmail routing script before any user script. The script routes on the
  # trusted X-Wickmail-Route header the LMTP proxy adds.
  dovecotSieveConfig = pkgs.writeText "wickmail-dovecot-sieve.conf" ''
    protocol lmtp {
      mail_plugins = $mail_plugins sieve
    }

    plugin {
      sieve_before = ${cfg.sieveScript}
    }
  '';
in
{
  options.services.wickmail.mail = {
    enable = mkEnableOption "the Wickmail inbound mail path (Postfix, Rspamd, Dovecot)";

    domain = mkOption {
      type = types.str;
      default = "example.com";
      description = "The primary mail domain Wickmail is authoritative for.";
    };

    hostname = mkOption {
      type = types.str;
      default = "mail.${cfg.domain}";
      description = "The mail host name advertised to remote servers.";
    };

    primaryAddresses = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Primary mailbox addresses that are always accepted at RCPT.";
    };

    policySocket = mkOption {
      type = types.path;
      default = "/run/wickmail/policy.sock";
      description = "Unix socket on which the Wickmail socketmap policy lookup listens.";
    };

    lmtpSocket = mkOption {
      type = types.path;
      default = "/run/wickmail/lmtp.sock";
      description = "Unix socket on which the Wickmail LMTP proxy listens.";
    };

    spoolDirectory = mkOption {
      type = types.path;
      default = "/var/lib/wickmail/spool";
      description = "Durable spool directory for accepted messages.";
    };

    stateDirectory = mkOption {
      type = types.path;
      default = "/var/lib/wickmail";
      description = "State directory holding the SQLite database.";
    };

    databasePath = mkOption {
      type = types.str;
      default = "${cfg.stateDirectory}/wickmail.db";
      description = "SQLite database file that holds aliases, policy, and provenance.";
    };

    mailDirectory = mkOption {
      type = types.path;
      default = "/var/vmail";
      description = "Dovecot mail root.";
    };

    quarantineDirectory = mkOption {
      type = types.path;
      default = "/var/vmail-quarantine";
      description = "Mail root for the isolated Aliases/Expired quarantine namespace.";
    };

    messageSizeLimit = mkOption {
      type = types.ints.positive;
      default = 26214400;
      description = "Maximum accepted message size in bytes.";
    };

    spam = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Run Rspamd for spam and malware classification before the LMTP proxy.";
      };
      milterSocket = mkOption {
        type = types.path;
        default = "/run/rspamd/rspamd-milter.sock";
        description = "Rspamd milter socket used by Postfix.";
      };
    };

    sieveScript = mkOption {
      type = types.path;
      default = ../../infra/dovecot/wickmail.sieve;
      description = "Global Sieve script that routes on X-Wickmail-Route.";
    };

    metrics = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Pass the metrics paths and token to the wickmail-server unit.";
      };
      diskPaths = mkOption {
        type = types.listOf types.str;
        default = [
          cfg.spoolDirectory
          cfg.mailDirectory
          cfg.quarantineDirectory
        ];
        description = "Filesystem paths whose free space is reported on /metrics.";
      };
      certificatePaths = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "PEM certificate paths whose expiry is reported on /metrics.";
      };
      tokenFile = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = ''
          A systemd EnvironmentFile that sets WICKMAIL_METRICS_TOKEN, so the
          /metrics endpoint requires a bearer token. Keep the file out of the
          Nix store and readable only by the service.
        '';
      };
    };

    serverPackage = mkOption {
      type = types.nullOr types.package;
      default = null;
      description = ''
        The wickmail-server package. When set, a systemd unit runs the policy
        lookup and LMTP proxy. When null, the unit is not created and the
        sockets are expected to be provided another way.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.primaryAddresses != [ ];
        message = "services.wickmail.mail.primaryAddresses must not be empty.";
      }
    ];

    # Postfix: RCPT-time policy lookup and LMTP delivery to the proxy.
    services.postfix = {
      enable = true;
      settings.main = {
        myhostname = cfg.hostname;
        mydomain = cfg.domain;
        mydestination = [ "localhost" ];
        relay_domains = [ cfg.domain ];
        virtual_mailbox_domains = [ cfg.domain ];
        virtual_transport = "lmtp:unix:${cfg.lmtpSocket}";
        smtpd_recipient_restrictions = lib.concatStringsSep ", " [
          "check_recipient_access socketmap:unix:${cfg.policySocket}:recipient"
          "permit_mynetworks"
          "reject_unauth_destination"
        ];
        message_size_limit = cfg.messageSizeLimit;
      };
    };

    # Rspamd: spam and malware classification before the proxy.
    services.rspamd = mkIf cfg.spam.enable {
      enable = true;
      postfix.enable = true;
    };

    # Dovecot: LMTP delivery, IMAP, mail auth, and global Sieve routing.
    services.dovecot2 = {
      enable = true;
      settings = {
        protocols = {
          imap = true;
          lmtp = true;
        };
        mail_driver = "maildir";
        mail_home = "${cfg.mailDirectory}/%{user | domain}/%{user | username}";
        mail_path = "~/mail";
        "namespace inbox" = {
          inbox = true;
          separator = "/";
        };
        # Aliases/Expired lives in a hidden namespace outside the user's IMAP
        # view; only the internal mail-store adapter reads it.
        "namespace quarantine" = {
          prefix = "Aliases/";
          separator = "/";
          hidden = true;
          list = false;
          location = "maildir:${cfg.quarantineDirectory}/%{user | domain}/%{user | username}";
        };
      };
      includeFiles = [ dovecotSieveConfig ];
    };

    # The Wickmail server owns the policy socket and the LMTP socket.
    systemd.services.wickmail-server = mkIf (cfg.serverPackage != null) {
      description = "Wickmail policy lookup and LMTP proxy";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      serviceConfig = {
        ExecStart = "${cfg.serverPackage}/bin/wickmail-server";
        DynamicUser = true;
        StateDirectory = "wickmail";
        RuntimeDirectory = "wickmail";
        Restart = "on-failure";
        Environment = [
          "WICKMAIL_DB=${cfg.databasePath}"
          "WICKMAIL_DOMAIN=${cfg.domain}"
          "WICKMAIL_HOSTNAME=${cfg.hostname}"
          "WICKMAIL_PRIMARY_ADDRESS=${lib.elemAt cfg.primaryAddresses 0}"
          "WICKMAIL_MAIL_DIR=${cfg.mailDirectory}"
          "WICKMAIL_SPOOL_DIR=${cfg.spoolDirectory}"
          "WICKMAIL_POLICY_SOCKET=${cfg.policySocket}"
          "WICKMAIL_LMTP_SOCKET=${cfg.lmtpSocket}"
        ]
        ++ lib.optionals cfg.metrics.enable [
          "WICKMAIL_METRICS_DISK_PATHS=${lib.concatStringsSep ":" cfg.metrics.diskPaths}"
          "WICKMAIL_METRICS_CERTIFICATE_PATHS=${lib.concatStringsSep ":" cfg.metrics.certificatePaths}"
        ];
        EnvironmentFile = mkIf (cfg.metrics.enable && cfg.metrics.tokenFile != null) cfg.metrics.tokenFile;
      };
    };
  };
}
