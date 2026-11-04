//! Binary entry point for `wickmail-server`.
//!
//! Runs the inbound mail path (`serve`) and provides administrative commands
//! used by operators and the integration harness: database migration, alias
//! creation, spool inspection, and mail-store reads.

use std::collections::HashMap;
use std::process::ExitCode;
use std::sync::Arc;

use wickmail_server::address::{CanonicalAddress, Domain};
use wickmail_server::clock::SystemClock;
use wickmail_server::generator::AliasGenerator;
use wickmail_server::mail::{MailStoreAdapter, ServerConfig, Spool, serve};
use wickmail_server::message::MessageId;
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
        "create-alias" => run_create_alias(&parsed),
        "spool-stats" => run_spool_stats(&parsed),
        "mail-store" => run_mail_store(&parsed),
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
    if let Some(name) = args.get("socketmap-name") {
        config.socketmap_name = name;
    }
    if let Some(hostname) = args.get("hostname") {
        config.hostname = hostname;
    }
    serve(config).map_err(|error| error.to_string())
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
    let adapter = MailStoreAdapter::open(maildir);
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
