# Example host configuration for Wickmail.
#
# Copy this into your own NixOS configuration and replace every placeholder.
# Host-specific values live here, never in the Wickmail flake. Secrets are
# expected to come from a secret manager; the placeholders below are not
# usable credentials.
{ inputs, ... }:
{
  imports = [ inputs.wickmail.nixosModules.default ];

  services.wickmail = {
    enable = true;
    domain = "example.com";
    primaryAddress = "user@example.com";
    hostname = "mail.example.com";

    # Required. Supply from sops-nix, agenix, or an out-of-store file.
    mailPassword = "REPLACE_ME";

    enableSubmission = true;
    enableManagementApi = true;
    httpListen = "127.0.0.1:8080";
    cookieSecure = true;

    dkimKeyFile = "/run/secrets/wickmail-dkim.pem";
    dkimSelector = "wickmail";

    tls = {
      certificateFile = "/var/lib/acme/mail.example.com/fullchain.pem";
      keyFile = "/var/lib/acme/mail.example.com/key.pem";
    };

    # Inbound abuse controls. Null keeps the server defaults.
    maxMessageBytes = 26214400;
    perSenderRate = 100;
    globalRate = 1000;
    perAliasQuarantineCount = 100;
    perAliasQuarantineBytes = 104857600;
    outboundRateLimit = 200;

    backup = {
      enable = true;
      outputDirectory = "/var/backup/wickmail";
      schedule = "*-*-* 03:30:00";
      retention = 14;
      configDirectory = "/etc/wickmail";
    };

    monitoring = {
      enable = true;
      interval = "5min";
      webhookUrl = "https://alerts.example.com/hooks/wickmail";
      textfile = "/var/lib/node-exporter/textfile/wickmail.prom";
      maxSpoolDepth = 1000;
      maxSpoolAgeSeconds = 3600;
      maxDiskPercent = 90;
      minCertificateDays = 14;
      maxAuthFailures = 20;
    };
  };

  security.acme = {
    acceptTerms = true;
    defaults.email = "postmaster@example.com";
    certs."mail.example.com" = { };
  };

  # Keep the management API on the loopback interface and terminate TLS in a
  # reverse proxy, or expose it directly behind your own TLS terminator.
  networking.firewall.allowedTCPPorts = [
    25
    587
    993
  ];
}
