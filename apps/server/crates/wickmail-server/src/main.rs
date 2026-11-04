//! Binary entry point for `wickmail-server`.
//!
//! Runs the inbound mail path (`serve`) and provides administrative commands
//! used by operators and the integration harness: database migration, alias
//! creation, spool inspection, and mail-store reads.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use time::Duration;
use wickmail_server::abuse::{AbusePolicy, RateLimit};
use wickmail_server::address::{CanonicalAddress, Domain};
use wickmail_server::api::ReplyRequest;
use wickmail_server::clock::SystemClock;
use wickmail_server::generator::AliasGenerator;
use wickmail_server::identity::IdentityService;
use wickmail_server::mail::{MailStoreAdapter, ServerConfig, Spool, serve};
use wickmail_server::message::MessageId;
use wickmail_server::quarantine::{DeleteReason, QuarantineManager, RetentionPolicy};
use wickmail_server::reply::{DkimSigner, FileOutboundQueue, ReplyClient};
use wickmail_server::service::{AliasService, CreateAlias, ExpiryChoice};
use wickmail_server::timestamp::Timestamp;
use wickmail_server::{PRODUCT_NAME, Store, StoreError, version};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("version");
    let parsed = Args::parse(&args[1..]);
    let result = match command {
        "version" | "--version" | "-V" => {
            println!("{} {}", PRODUCT_NAME, version());
            Ok(())
        }
        "migrate" => run_migrate(&parsed),
        "serve" => run_serve(&parsed),
        "bootstrap" => run_bootstrap(&parsed),
        "set-password" => run_set_password(&parsed),
        "reset-password" => run_reset_password(&parsed),
        "recovery-codes" => run_recovery_codes(&parsed),
        "mail-credential" => run_mail_credential(&parsed),
        "create-alias" => run_create_alias(&parsed),
        "spool-stats" => run_spool_stats(&parsed),
        "mail-store" => run_mail_store(&parsed),
        "quarantine" => run_quarantine(&parsed),
        "reply-context" => run_reply_context(&parsed),
        "reply" => run_reply(&parsed),
        other => Err(format!("unknown command: {other}")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn run_migrate(args: &Args) -> Result<(), String> {
    let path = args
        .positional
        .first()
        .cloned()
        .or_else(|| args.get("db"))
        .ok_or_else(|| "usage: migrate <database>".to_string())?;
    let mut store = Store::open(&path).map_err(store_error)?;
    store.migrate().map_err(store_error)?;
    let schema_version = store.schema_version().map_err(store_error)?;
    println!("schema version: {schema_version}");
    Ok(())
}

/// Creates the single user and prints a single-use setup token.
///
/// This is the only way to create credentials: there are no defaults, and the
/// command runs locally against the database file.
fn run_bootstrap(args: &Args) -> Result<(), String> {
    let db_path = args.required("db")?;
    let primary = args.required("primary")?;
    let username = args.get("username").unwrap_or_else(|| primary.clone());
    let mut store = Store::open(&db_path).map_err(store_error)?;
    store.migrate().map_err(store_error)?;
    let identity = IdentityService::new(&store, Arc::new(SystemClock));
    let (user, token) = identity
        .bootstrap(username, primary)
        .map_err(|error| error.to_string())?;
    println!("user: {}", user.id);
    println!("setup token: {token}");
    println!("This token is single-use and expires in 24 hours.");
    println!("Complete setup with `set-password`, or POST it to /v1/setup.");
    Ok(())
}

/// Completes first-run setup from the host with the setup token.
fn run_set_password(args: &Args) -> Result<(), String> {
    let db_path = args.required("db")?;
    let token = args.required("setup-token")?;
    let password = password_arg(args)?;
    let mut store = Store::open(&db_path).map_err(store_error)?;
    store.migrate().map_err(store_error)?;
    let identity = IdentityService::new(&store, Arc::new(SystemClock));
    let user = identity
        .complete_setup(&token, &password)
        .map_err(|error| error.to_string())?;
    println!("setup complete for {}", user.id);
    Ok(())
}

/// Resets the management password from the host and revokes all sessions.
fn run_reset_password(args: &Args) -> Result<(), String> {
    let db_path = args.required("db")?;
    let password = password_arg(args)?;
    let mut store = Store::open(&db_path).map_err(store_error)?;
    store.migrate().map_err(store_error)?;
    let identity = IdentityService::new(&store, Arc::new(SystemClock));
    let user = identity
        .reset_password(&password)
        .map_err(|error| error.to_string())?;
    println!("password reset for {}; existing sessions revoked", user.id);
    Ok(())
}

/// Generates one-time recovery codes, replacing unused ones.
fn run_recovery_codes(args: &Args) -> Result<(), String> {
    let db_path = args.required("db")?;
    let mut store = Store::open(&db_path).map_err(store_error)?;
    store.migrate().map_err(store_error)?;
    let identity = IdentityService::new(&store, Arc::new(SystemClock));
    let codes = identity
        .rotate_recovery_codes()
        .map_err(|error| error.to_string())?;
    println!("one-time recovery codes (shown once):");
    for code in codes {
        println!("{code}");
    }
    Ok(())
}

/// Shows, rotates, or revokes the separate Dovecot mail credential.
fn run_mail_credential(args: &Args) -> Result<(), String> {
    let subcommand = args
        .positional
        .first()
        .map(String::as_str)
        .ok_or_else(|| "usage: mail-credential show|rotate|revoke --db <path>".to_string())?;
    let db_path = args.required("db")?;
    let mut store = Store::open(&db_path).map_err(store_error)?;
    store.migrate().map_err(store_error)?;
    let identity = IdentityService::new(&store, Arc::new(SystemClock));
    match subcommand {
        "show" => match identity
            .mail_credential()
            .map_err(|error| error.to_string())?
        {
            Some(credential) => println!(
                "configured={} rotated_at={:?} revoked_at={:?}",
                credential.is_configured(),
                credential.rotated_at,
                credential.revoked_at
            ),
            None => println!("no mail credential configured"),
        },
        "rotate" => {
            let password = args
                .get("password")
                .unwrap_or_else(|| wickmail_server::identity::random_secret(18));
            identity
                .rotate_mail_credential(&password)
                .map_err(|error| error.to_string())?;
            println!("mail password: {password}");
            println!("Update Dovecot with this password; it is shown once.");
        }
        "revoke" => {
            identity
                .revoke_mail_credential()
                .map_err(|error| error.to_string())?;
            println!("mail credential revoked");
        }
        other => return Err(format!("unknown mail-credential subcommand: {other}")),
    }
    Ok(())
}

/// Reads a password from `--password` or standard input.
fn password_arg(args: &Args) -> Result<String, String> {
    if let Some(value) = args.get("password") {
        return Ok(value);
    }
    if args.flag("password-stdin") {
        let mut buffer = String::new();
        std::io::stdin()
            .read_line(&mut buffer)
            .map_err(|error| error.to_string())?;
        return Ok(buffer.trim_end_matches(['\r', '\n']).to_string());
    }
    Err("provide --password or --password-stdin".to_string())
}

fn run_serve(args: &Args) -> Result<(), String> {
    let db_path = args.required("db")?;
    let domain = Domain::parse(&args.required("domain")?).map_err(|error| error.to_string())?;
    let primary =
        CanonicalAddress::parse(&args.required("primary")?).map_err(|error| error.to_string())?;
    let policy_socket = args.required("policy-socket")?;
    let lmtp_socket = args.required("lmtp-socket")?;
    let dovecot_lmtp = wickmail_server::mail::LmtpTarget::parse(&args.required("dovecot-lmtp")?)
        .ok_or_else(|| {
            "invalid --dovecot-lmtp; expected unix:/path or inet:host:port".to_string()
        })?;
    let spool_dir = args.required("spool-dir")?;

    let mut config = ServerConfig::new(
        db_path,
        domain,
        primary,
        policy_socket,
        lmtp_socket,
        dovecot_lmtp,
        spool_dir,
    );
    if let Some(max) = args.get("max-spool") {
        config.max_spool_entries = max
            .parse()
            .map_err(|_| "--max-spool must be an integer".to_string())?;
    }
    if let Some(socket) = args.get("submission-socket") {
        config.submission_socket = Some(socket.into());
    }
    if let Some(name) = args.get("socketmap-name") {
        config.socketmap_name = name;
    }
    if let Some(hostname) = args.get("hostname") {
        config.hostname = hostname;
    }
    if let Some(maildir) = args.get("maildir") {
        config.maildir = Some(maildir.into());
        config.quarantine_dir = args.get("quarantine-dir").map(Into::into);
    }
    config.retention = retention_from_args(args)?;
    if let Some(seconds) = args.get("maintenance-interval") {
        config.maintenance_interval = std::time::Duration::from_secs(
            seconds
                .parse()
                .map_err(|_| "--maintenance-interval must be an integer".to_string())?,
        );
    }
    if let Some(listen) = args.get("http-listen") {
        config.http_listen = Some(
            listen
                .parse::<SocketAddr>()
                .map_err(|_| "--http-listen must be host:port".to_string())?,
        );
    }
    if let Some(root) = args.get("web-root") {
        config.web_root = Some(root.into());
    }
    if let Some(dir) = args.get("outbound-dir") {
        config.outbound_dir = Some(dir.into());
    }
    if args.flag("cookie-insecure") {
        config.cookie_secure = false;
    }
    config.abuse = abuse_from_args(args)?;
    if let Some(key) = args.get("dkim-key") {
        config.dkim_key = Some(key.into());
    }
    if let Some(selector) = args.get("dkim-selector") {
        config.dkim_selector = selector;
    }
    serve(config).map_err(|error| error.to_string())
}

/// Builds an inbound abuse policy from CLI options.
fn abuse_from_args(args: &Args) -> Result<AbusePolicy, String> {
    let mut policy = AbusePolicy::default();
    if let Some(bytes) = args.get("max-message-bytes") {
        policy.max_message_bytes = bytes
            .parse()
            .map_err(|_| "--max-message-bytes must be an integer".to_string())?;
    }
    if let Some(rate) = args.get("per-sender-rate") {
        policy.per_sender =
            Some(RateLimit::per_hour(rate.parse().map_err(|_| {
                "--per-sender-rate must be an integer".to_string()
            })?));
    }
    if let Some(rate) = args.get("global-rate") {
        policy.global =
            Some(RateLimit::per_hour(rate.parse().map_err(|_| {
                "--global-rate must be an integer".to_string()
            })?));
    }
    if let Some(count) = args.get("per-alias-count") {
        policy.per_alias_quarantine_count = Some(
            count
                .parse()
                .map_err(|_| "--per-alias-count must be an integer".to_string())?,
        );
    }
    if let Some(bytes) = args.get("per-alias-bytes") {
        policy.per_alias_quarantine_bytes = Some(
            bytes
                .parse()
                .map_err(|_| "--per-alias-bytes must be an integer".to_string())?,
        );
    }
    Ok(policy)
}

/// Builds a retention policy from `--lease-retention-days` style options.
fn retention_from_args(args: &Args) -> Result<RetentionPolicy, String> {
    let mut policy = RetentionPolicy::default();
    if let Some(days) = args.get("lease-retention-days") {
        policy.lease.retention = Duration::days(parse_i64(&days, "lease-retention-days")?);
    }
    if let Some(days) = args.get("spam-retention-days") {
        policy.spam.retention = Duration::days(parse_i64(&days, "spam-retention-days")?);
    }
    if let Some(count) = args.get("lease-count-quota") {
        policy.lease.count_quota = Some(
            count
                .parse()
                .map_err(|_| "--lease-count-quota must be an integer".to_string())?,
        );
    }
    if let Some(count) = args.get("spam-count-quota") {
        policy.spam.count_quota = Some(
            count
                .parse()
                .map_err(|_| "--spam-count-quota must be an integer".to_string())?,
        );
    }
    Ok(policy)
}

fn parse_i64(value: &str, name: &str) -> Result<i64, String> {
    value
        .parse()
        .map_err(|_| format!("--{name} must be an integer"))
}

fn run_quarantine(args: &Args) -> Result<(), String> {
    let subcommand = args
        .positional
        .first()
        .map(String::as_str)
        .ok_or_else(|| "usage: quarantine list|reconcile|sweep|recover|delete".to_string())?;
    let db_path = args.required("db")?;
    let maildir = args.required("maildir")?;
    let mut store = Store::open(&db_path).map_err(store_error)?;
    store.migrate().map_err(store_error)?;
    let adapter = match args.get("quarantine-dir") {
        Some(quarantine_dir) => MailStoreAdapter::with_quarantine(maildir, quarantine_dir),
        None => MailStoreAdapter::open(maildir),
    };
    let policy = retention_from_args(args)?;
    let manager = QuarantineManager::new(&store, &adapter, policy, Arc::new(SystemClock));

    match subcommand {
        "list" => {
            for entry in manager.list().map_err(|error| error.to_string())? {
                println!(
                    "{} {:?} {:?} {} {}",
                    entry.message_id,
                    entry.kind,
                    entry.status,
                    entry.quarantine_expires_at,
                    entry.subject
                );
            }
            Ok(())
        }
        "reconcile" => {
            let report = manager.reconcile().map_err(|error| error.to_string())?;
            println!(
                "scanned={} rebuilt={} recovered={} deletions={} requeued={} duplicates={} deleted={} locators={}",
                report.scanned,
                report.metadata_rebuilt,
                report.completed_recoveries,
                report.completed_deletions,
                report.restored_to_quarantine,
                report.removed_duplicate_copies,
                report.marked_deleted,
                report.locators_refreshed,
            );
            Ok(())
        }
        "sweep" => {
            let report = manager
                .retention_sweep()
                .map_err(|error| error.to_string())?;
            println!("deleted={} purged={}", report.deleted, report.purged);
            Ok(())
        }
        "recover" => {
            let id = message_id_arg(args)?;
            let metadata = manager.recover(id).map_err(|error| error.to_string())?;
            println!("{} {:?}", metadata.message_id, metadata.status);
            Ok(())
        }
        "delete" => {
            let id = message_id_arg(args)?;
            let metadata = manager
                .delete(id, DeleteReason::UserRequest)
                .map_err(|error| error.to_string())?;
            println!("{} {:?}", metadata.message_id, metadata.status);
            Ok(())
        }
        other => Err(format!("unknown quarantine subcommand: {other}")),
    }
}

fn message_id_arg(args: &Args) -> Result<MessageId, String> {
    args.required("message-id")?
        .parse()
        .map_err(|error| format!("invalid --message-id: {error}"))
}

fn run_create_alias(args: &Args) -> Result<(), String> {
    let db_path = args.required("db")?;
    let domain = Domain::parse(&args.required("domain")?).map_err(|error| error.to_string())?;
    let mut store = Store::open(&db_path).map_err(store_error)?;
    store.migrate().map_err(store_error)?;
    let service = AliasService::new(
        store,
        AliasGenerator::new(),
        domain.clone(),
        Arc::new(SystemClock),
    );

    let expiry = if let Some(seconds) = args.get("lease") {
        let seconds: i64 = seconds
            .parse()
            .map_err(|_| "--lease must be an integer".to_string())?;
        ExpiryChoice::LeaseSeconds(Some(seconds))
    } else if let Some(expires_at) = args.get("expires-at") {
        ExpiryChoice::Absolute(
            expires_at
                .parse::<Timestamp>()
                .map_err(|error| error.to_string())?,
        )
    } else if args.flag("never") {
        ExpiryChoice::Never
    } else {
        ExpiryChoice::LeaseSeconds(None)
    };

    let request = CreateAlias {
        label: args.get("label"),
        purpose: args.get("purpose"),
        expiry,
        renew_on_outbound: args
            .get("renew-on-outbound")
            .map(|value| value != "false" && value != "0")
            .unwrap_or(true),
    };

    let alias = match args.get("local-part") {
        Some(local_part) => {
            let address = CanonicalAddress::from_parts(&local_part, &domain)
                .map_err(|error| error.to_string())?;
            service
                .create_with_address(address, request)
                .map_err(|error| error.to_string())?
        }
        None => service.create(request).map_err(|error| error.to_string())?,
    };

    let alias = if args.flag("disable") {
        service
            .disable(alias.id)
            .map_err(|error| error.to_string())?
    } else {
        alias
    };

    let json = serde_json::to_string_pretty(&alias).map_err(|error| error.to_string())?;
    println!("{json}");
    Ok(())
}

fn run_spool_stats(args: &Args) -> Result<(), String> {
    let dir = args.required("dir")?;
    let spool = Spool::open(dir, usize::MAX).map_err(|error| error.to_string())?;
    let stats = spool.stats().map_err(|error| error.to_string())?;
    println!(
        "depth={} oldest_age_seconds={}",
        stats.depth,
        stats
            .oldest_age_seconds
            .map(|age| age.to_string())
            .unwrap_or_else(|| "none".to_string())
    );
    Ok(())
}

fn run_mail_store(args: &Args) -> Result<(), String> {
    let subcommand = args
        .positional
        .first()
        .map(String::as_str)
        .ok_or_else(|| "usage: mail-store list|read --maildir <path>".to_string())?;
    let maildir = args.required("maildir")?;
    let adapter = match args.get("quarantine-dir") {
        Some(quarantine_dir) => MailStoreAdapter::with_quarantine(maildir, quarantine_dir),
        None => MailStoreAdapter::open(maildir),
    };
    match subcommand {
        "list" => {
            let mailbox = args.get("mailbox").unwrap_or_else(|| "Inbox".to_string());
            for summary in adapter.list(&mailbox).map_err(|error| error.to_string())? {
                println!(
                    "{} {} {}",
                    summary.message_id, summary.mailbox, summary.size
                );
            }
            Ok(())
        }
        "quarantine" => {
            for summary in adapter.quarantine().map_err(|error| error.to_string())? {
                println!(
                    "{} {} {}",
                    summary.message_id, summary.mailbox, summary.size
                );
            }
            Ok(())
        }
        "read" => {
            let mailbox = args.get("mailbox").unwrap_or_else(|| "Inbox".to_string());
            let message_id: MessageId = args
                .required("message-id")?
                .parse()
                .map_err(|error| format!("{error}"))?;
            let bytes = adapter
                .read(&mailbox, message_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("message {message_id} not found in {mailbox}"))?;
            print!("{}", String::from_utf8_lossy(&bytes));
            Ok(())
        }
        other => Err(format!("unknown mail-store subcommand: {other}")),
    }
}

fn run_reply_context(args: &Args) -> Result<(), String> {
    let message_id = args
        .positional
        .first()
        .ok_or_else(|| reply_usage("reply-context"))?;
    let message_id: MessageId = message_id.parse().map_err(|error| format!("{error}"))?;
    let client = build_reply_client(args)?;
    let context = client
        .fetch_reply_context(message_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("no reply context for message {message_id}"))?;
    let json = serde_json::to_string_pretty(&context).map_err(|error| error.to_string())?;
    println!("{json}");
    Ok(())
}

fn run_reply(args: &Args) -> Result<(), String> {
    let message_id = args
        .positional
        .first()
        .ok_or_else(|| reply_usage("reply"))?;
    let message_id: MessageId = message_id.parse().map_err(|error| format!("{error}"))?;
    let alias_id = match args.get("alias") {
        Some(value) => Some(
            value
                .parse::<wickmail_server::alias::AliasId>()
                .map_err(|error| format!("{error}"))?,
        ),
        None => None,
    };
    let request = ReplyRequest {
        alias_id,
        primary: None,
        body: args.get("body").unwrap_or_default(),
        quoted_text: args.get("quote"),
    };
    let client = build_reply_client(args)?;
    let response = client
        .submit_reply(message_id, &request)
        .map_err(|error| error.to_string())?;
    let json = serde_json::to_string_pretty(&response).map_err(|error| error.to_string())?;
    println!("{json}");
    Ok(())
}

fn reply_usage(command: &str) -> String {
    format!(
        "usage: {command} <message-id> --db <path> --domain <domain> --maildir <path> \
         --outbound-dir <path> [--primary <address>] [--dkim-key <pem>] [--dkim-selector <name>]"
    )
}

/// Builds a reply client from CLI flags.
fn build_reply_client(args: &Args) -> Result<ReplyClient, String> {
    let db_path = args.required("db")?;
    let domain = Domain::parse(&args.required("domain")?).map_err(|error| error.to_string())?;
    let mut store = Store::open(&db_path).map_err(store_error)?;
    store.migrate().map_err(store_error)?;
    let service = Arc::new(Mutex::new(AliasService::new(
        store,
        AliasGenerator::new(),
        domain.clone(),
        Arc::new(SystemClock),
    )));

    let maildir = args.required("maildir")?;
    let mail = match args.get("quarantine-dir") {
        Some(quarantine_dir) => MailStoreAdapter::with_quarantine(maildir, quarantine_dir),
        None => MailStoreAdapter::open(maildir),
    };

    let outbound_dir = args.required("outbound-dir")?;
    let queue = Arc::new(FileOutboundQueue::open(outbound_dir).map_err(|error| error.to_string())?);

    let dkim = match args.get("dkim-key") {
        Some(path) => {
            let pem = std::fs::read_to_string(&path)
                .map_err(|error| format!("cannot read DKIM key {path}: {error}"))?;
            let selector = args
                .get("dkim-selector")
                .unwrap_or_else(|| "wickmail".to_string());
            Some(
                DkimSigner::from_pem(domain.clone(), selector, &pem)
                    .map_err(|error| error.to_string())?,
            )
        }
        None => None,
    };

    let primary = match args.get("primary") {
        Some(value) => Some(CanonicalAddress::parse(&value).map_err(|error| error.to_string())?),
        None => None,
    };

    Ok(ReplyClient::new(
        service,
        mail,
        queue,
        dkim,
        primary,
        Arc::new(SystemClock),
    ))
}

fn store_error(error: StoreError) -> String {
    format!("store error: {error}")
}

/// A minimal `--key value` and `--flag` argument parser.
struct Args {
    positional: Vec<String>,
    values: HashMap<String, String>,
    flags: std::collections::HashSet<String>,
}

impl Args {
    fn parse(args: &[String]) -> Self {
        let mut positional = Vec::new();
        let mut values = HashMap::new();
        let mut flags = std::collections::HashSet::new();
        let mut index = 0;
        while index < args.len() {
            let argument = &args[index];
            if let Some(key) = argument.strip_prefix("--") {
                let key = key.to_string();
                let next = args.get(index + 1);
                match next {
                    Some(value) if !value.starts_with("--") => {
                        values.insert(key, value.clone());
                        index += 2;
                    }
                    _ => {
                        flags.insert(key);
                        index += 1;
                    }
                }
            } else {
                positional.push(argument.clone());
                index += 1;
            }
        }
        Self {
            positional,
            values,
            flags,
        }
    }

    fn get(&self, key: &str) -> Option<String> {
        self.values.get(key).cloned()
    }

    fn required(&self, key: &str) -> Result<String, String> {
        self.get(key)
            .ok_or_else(|| format!("missing required --{key}"))
    }

    fn flag(&self, key: &str) -> bool {
        self.flags.contains(key)
    }
}
