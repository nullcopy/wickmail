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

  # A recent state version selects the Dovecot 2.4 settings interface.
  system.stateVersion = "26.05";
}
