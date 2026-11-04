# NixOS module for the Wickmail inbound mail path.
#
# Wires Postfix (RCPT policy lookup and LMTP delivery), Rspamd (spam and
# malware scanning before the proxy), Dovecot (LMTP, IMAP, mail authentication,
# and global Sieve routing), and the wickmail-server process that owns the
# policy socketmap, the LMTP proxy, the durable spool, and the alias database.
#
# The module is parameterised by `self` so the server package defaults to this
# flake's build.
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.wickmail;
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;

  system = pkgs.stdenv.hostPlatform.system;
  runDir = "/run/wickmail";
  doveconf = config.services.dovecot2.package;

  globalSieve = pkgs.writeTextFile {
    name = "wickmail-global.sieve";
    text = ''
      require ["fileinto", "mailbox"];

      # Spam wins regardless of alias state.
      if header :contains "X-Wickmail-Route" "Spam" {
        fileinto :create "Spam";
        stop;
      }

      # Expired and disabled aliases are quarantined outside the user's
      # IMAP namespace.
      if header :contains "X-Wickmail-Route" "Quarantine" {
        fileinto :create "Aliases/Expired";
        stop;
      }

      # Everything else stays in the inbox.
      keep;
    '';
  };
in
{
  options.services.wickmail = {
    enable = mkEnableOption "the Wickmail inbound mail path";

    package = mkOption {
      type = types.package;
      default = self.packages.${system}.wickmail-server;
      defaultText = lib.literalExpression "self.packages.\${system}.wickmail-server";
      description = "The wickmail-server package.";
    };

    domain = mkOption {
      type = types.str;
      default = "localhost";
      example = "wickmail.example.com";
      description = "The alias domain.";
    };

    primaryAddress = mkOption {
      type = types.str;
      example = "user@example.com";
      description = "The account's primary address.";
    };

    hostname = mkOption {
      type = types.str;
      default = "mail.${cfg.domain}";
      defaultText = lib.literalExpression ''"mail.''${config.services.wickmail.domain}"'';
      description = "The mail host name used by Postfix and the LMTP proxy.";
    };

    mailPassword = mkOption {
      type = types.str;
      default = "wickmail";
      description = ''
        Password for the single Dovecot mail account. Management
        authentication is separate and is not configured by this module.
      '';
    };

    stateDir = mkOption {
      type = types.path;
      default = "/var/lib/wickmail";
      description = "Directory holding the alias database and the spool.";
    };

    mailRoot = mkOption {
      type = types.path;
      default = "/var/vmail";
      description = "Maildir root for the account and the quarantine mailbox.";
    };

    maildir = mkOption {
      type = types.path;
      default = "${cfg.mailRoot}/Maildir";
      defaultText = lib.literalExpression ''"''${config.services.wickmail.mailRoot}/Maildir"'';
      description = "The account Maildir root used by reconciliation and retention.";
    };

    quarantineDir = mkOption {
      type = types.path;
      default = "${cfg.mailRoot}/quarantine/.Expired";
      defaultText = lib.literalExpression ''"''${config.services.wickmail.mailRoot}/quarantine/.Expired"'';
      description = "The on-disk directory for the Aliases/Expired quarantine mailbox.";
    };

    user = mkOption {
      type = types.str;
      default = "wickmail";
      description = "System user that runs wickmail-server.";
    };

    group = mkOption {
      type = types.str;
      default = "wickmail";
      description = "System group for wickmail-server.";
    };

    mailUser = mkOption {
      type = types.str;
      default = "vmail";
      description = "Mail owner for the Dovecot mail store.";
    };

    mailGroup = mkOption {
      type = types.str;
      default = "vmail";
      description = "Mail group for the Dovecot mail store.";
    };

    maxSpoolEntries = mkOption {
      type = types.int;
      default = 10000;
      description = "Maximum number of messages held in the durable spool.";
    };

    enableRspamd = mkOption {
      type = types.bool;
      default = true;
      description = "Run Rspamd as a Postfix milter before the LMTP proxy.";
    };

    extraPostfixSettings = mkOption {
      type = types.attrsOf types.anything;
      default = { };
      description = "Extra Postfix main.cf settings.";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = config.services.dovecot2.enable;
        message = "services.wickmail requires services.dovecot2.enable = true.";
      }
    ];

    services.dovecot2.enable = lib.mkDefault true;

    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      description = "Wickmail server";
    };
    users.groups.${cfg.group} = { };

    systemd.tmpfiles.rules = [
      "d /run/wickmail 0755 root root -"
      "d ${cfg.mailRoot} 0750 ${cfg.mailUser} ${cfg.mailGroup} -"
      "d ${cfg.mailRoot}/sieve-bin 0750 ${cfg.mailUser} ${cfg.mailGroup} -"
      "d ${cfg.stateDir} 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/spool 0750 ${cfg.user} ${cfg.group} -"
    ];

    environment.etc."dovecot/sieve/before/global.sieve".source = globalSieve;

    environment.systemPackages = [
      doveconf.passthru.dovecot_pigeonhole
      cfg.package
    ];

    services.dovecot2.settings = {
      dovecot_config_version = doveconf.version;
      dovecot_storage_version = doveconf.version;
      protocols = {
        imap = true;
        lmtp = true;
      };
      mail_driver = "maildir";
      mail_home = cfg.mailRoot;
      mail_path = "~/Maildir";
      mail_uid = cfg.mailUser;
      mail_gid = cfg.mailGroup;

      "namespace inbox" = {
        inbox = true;
        separator = "/";
      };
      # The quarantine mailbox lives outside the user's IMAP namespace and is
      # reachable only through the internal mail-store adapter.
      "namespace quarantine" = {
        prefix = "Aliases/";
        separator = "/";
        mail_driver = "maildir";
        mail_path = "${cfg.mailRoot}/quarantine";
        hidden = true;
        list = false;
        inbox = false;
      };

      "passdb static" = {
        password = cfg.mailPassword;
      };
      "userdb static" = {
        allow_all_users = true;
        fields = {
          uid = cfg.mailUser;
          gid = cfg.mailGroup;
          home = cfg.mailRoot;
        };
      };

      "protocol lmtp" = {
        mail_plugins = {
          sieve = true;
        };
      };
      "sieve_script before" = {
        type = "before";
        driver = "file";
        path = "/etc/dovecot/sieve/before/";
        bin_path = "${cfg.mailRoot}/sieve-bin";
      };

      service = [
        {
          _section.name = "lmtp";
          # The default LMTP listener resolves to /run/dovecot2/lmtp; set its
          # mode so the proxy can connect without duplicating the listener.
          "unix_listener lmtp" = {
            mode = "0666";
          };
        }
      ];
    };

    services.rspamd = mkIf cfg.enableRspamd {
      enable = true;
      postfix.enable = true;
      # Classify and annotate, but never reject or greylist: after SMTP
      # acceptance the proxy and Sieve own routing, and a single-user v1 does
      # not want first-delivery deferrals.
      locals."actions.conf".text = ''
        reject = 999;
        greylist = 999;
      '';
    };

    services.postfix = {
      enable = true;
      transport = ''
        ${cfg.domain} lmtp:unix:${runDir}/lmtp.sock
      '';
      settings.main = {
        myhostname = cfg.hostname;
        inet_interfaces = "all";
        mydestination = [
          "$myhostname"
          "localhost"
        ];
        relay_domains = [ cfg.domain ];
        smtpd_recipient_restrictions = "check_recipient_access socketmap:unix:${runDir}/policy.sock:wickmail-policy";
        # Unknown and disabled recipients are permanent failures; the design
        # specifies 550.
        access_map_reject_code = 550;
        milter_default_action = "accept";
      }
      // cfg.extraPostfixSettings;
    };

    systemd.services.wickmail = {
      description = "Wickmail inbound mail path";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network.target"
        "dovecot.service"
      ];
      before = [ "postfix.service" ];
      wants = [ "dovecot.service" ];
      serviceConfig = {
        ExecStart = lib.concatStringsSep " " [
          "${cfg.package}/bin/wickmail-server"
          "serve"
          "--db ${cfg.stateDir}/wickmail.sqlite"
          "--domain ${cfg.domain}"
          "--primary ${cfg.primaryAddress}"
          "--policy-socket ${runDir}/policy.sock"
          "--lmtp-socket ${runDir}/lmtp.sock"
          "--dovecot-lmtp unix:/run/dovecot2/lmtp"
          "--spool-dir ${cfg.stateDir}/spool"
          "--max-spool ${toString cfg.maxSpoolEntries}"
          "--hostname ${cfg.hostname}"
          "--maildir ${cfg.maildir}"
          "--quarantine-dir ${cfg.quarantineDir}"
        ];
        # The proxy needs access to the mail store and the Dovecot LMTP socket;
        # privilege separation is tracked separately.
        User = "root";
        Group = "root";
        StateDirectory = "wickmail";
        Restart = "on-failure";
        RestartSec = "1s";
      };
      preStart = ''
        ${cfg.package}/bin/wickmail-server migrate ${cfg.stateDir}/wickmail.sqlite
      '';
    };
  };
}
