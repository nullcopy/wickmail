//! Inbound mail path runtime.
//!
//! Wires the RCPT policy socketmap, the LMTP proxy, the durable spool, and the
//! spool worker into one process. The alias database is owned here and shared
//! by the policy lookup and the delivery path through a mutex.

use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use thiserror::Error;

use crate::address::{CanonicalAddress, Domain};
use crate::clock::{SharedClock, SystemClock};
use crate::db::{Store, StoreError};
use crate::generator::AliasGenerator;
use crate::mail::delivery::{PlannedDelivery, plan};
use crate::mail::headers::{MessageParts, WICKMAIL_HEADER_PREFIX};
use crate::mail::lmtp::{
    Envelope, LmtpClient, LmtpTarget, MessageHandler, RecipientReply, bind as bind_lmtp,
    serve_session,
};
use crate::mail::policy::RecipientPolicy;
use crate::mail::socketmap::{self, DEFAULT_SOCKETMAP_NAME};
use crate::mail::spool::{Spool, SpoolError, SpoolMeta};
use crate::message::{Message, Route};
use crate::service::AliasService;

/// Runtime configuration for the inbound mail path.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    /// Path to the SQLite alias database.
    pub db_path: PathBuf,
    /// The alias domain.
    pub domain: Domain,
    /// The account's primary address.
    pub primary: CanonicalAddress,
    /// Unix socket Postfix uses for the RCPT policy lookup.
    pub policy_socket: PathBuf,
    /// Unix socket the LMTP proxy listens on.
    pub lmtp_socket: PathBuf,
    /// Where the proxy forwards accepted mail.
    pub dovecot_lmtp: LmtpTarget,
    /// Durable spool directory.
    pub spool_dir: PathBuf,
    /// Maximum number of spooled messages before the spool reports full.
    pub max_spool_entries: usize,
    /// Socketmap name Postfix sends in lookups.
    pub socketmap_name: String,
    /// Hostname reported in LMTP greetings.
    pub hostname: String,
}

impl ServerConfig {
    /// Builds a configuration with default socketmap name and hostname.
    pub fn new(
        db_path: impl Into<PathBuf>,
        domain: Domain,
        primary: CanonicalAddress,
        policy_socket: impl Into<PathBuf>,
        lmtp_socket: impl Into<PathBuf>,
        dovecot_lmtp: LmtpTarget,
        spool_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            db_path: db_path.into(),
            domain,
            primary,
            policy_socket: policy_socket.into(),
            lmtp_socket: lmtp_socket.into(),
            dovecot_lmtp,
            spool_dir: spool_dir.into(),
            max_spool_entries: 10_000,
            socketmap_name: DEFAULT_SOCKETMAP_NAME.to_string(),
            hostname: "wickmail".to_string(),
        }
    }
}

/// Why the runtime could not start.
#[derive(Debug, Error)]
pub enum RuntimeError {
    /// The alias database could not be opened.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The spool could not be opened.
    #[error(transparent)]
    Spool(#[from] SpoolError),
    /// A socket could not be bound.
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// The composed inbound mail path: policy, spool, and Dovecot forwarder.
pub struct MailPath {
    policy: Arc<RecipientPolicy>,
    spool: Arc<Spool>,
    client: Arc<LmtpClient>,
    service: Arc<Mutex<AliasService>>,
    primary: CanonicalAddress,
    clock: SharedClock,
}

impl MailPath {
    /// Creates a mail path from its components.
    pub fn new(
        policy: Arc<RecipientPolicy>,
        spool: Arc<Spool>,
        client: Arc<LmtpClient>,
        service: Arc<Mutex<AliasService>>,
        primary: CanonicalAddress,
        clock: SharedClock,
    ) -> Self {
        Self {
            policy,
            spool,
            client,
            service,
            primary,
            clock,
        }
    }

    /// The durable spool.
    pub fn spool(&self) -> &Arc<Spool> {
        &self.spool
    }

    /// Evaluates an envelope, annotates it with trusted headers, and spools it.
    pub fn process(&self, envelope: Envelope) -> Vec<RecipientReply> {
        let count = envelope.recipients.len();
        let mut parsed = Vec::new();
        let mut unparseable = false;
        for raw in &envelope.recipients {
            match CanonicalAddress::parse(raw) {
                Ok(address) => parsed.push(address),
                Err(_) => unparseable = true,
            }
        }

        let mut message = MessageParts::parse(&envelope.data);
        let spam = message.headers.is_spam();
        message.headers.strip_prefix(WICKMAIL_HEADER_PREFIX);
        let visible = message.headers.visible_recipients();

        let planned = match plan(&parsed, spam, |address| self.policy.resolve(address)) {
            Ok(planned) => planned,
            Err(error) => {
                eprintln!("wickmail: delivery policy unavailable: {error}");
                return vec![RecipientReply::temporary("4.3.0 policy unavailable"); count];
            }
        };
        let route = if unparseable && !spam {
            Route::Quarantine
        } else {
            planned.route
        };
        let subject = message.headers.get("Subject").unwrap_or("").to_string();
        let received_at = self.clock.now();
        annotate(&mut message, &planned, route, received_at);

        let meta = SpoolMeta {
            message_id: planned.message_id,
            sender: envelope.sender.clone(),
            dovecot_recipient: self.primary.to_string(),
            alias_ids: planned.alias_ids.clone(),
            primary_received: planned.primary_received,
            route,
            subject,
            received_at,
            attempts: 0,
        };

        // Cross-check the visible To/Cc for display only; the envelope is
        // authoritative.
        if !planned.unknown.is_empty() {
            eprintln!(
                "wickmail: message {} had unrecognized recipients {:?}",
                planned.message_id, planned.unknown
            );
        }
        if !visible.is_empty() && visible != parsed {
            eprintln!(
                "wickmail: message {} envelope and visible recipients differ",
                planned.message_id
            );
        }

        match self.spool.enqueue(&message.to_bytes(), &meta) {
            Ok(()) => {
                vec![
                    RecipientReply::accepted(format!("2.0.0 Ok: queued as {}", planned.message_id));
                    count
                ]
            }
            Err(error) => {
                eprintln!("wickmail: spool unavailable: {error}");
                vec![RecipientReply::temporary("4.3.0 spool unavailable"); count]
            }
        }
    }

    /// Forwards every spooled message to Dovecot, recording provenance on
    /// success. Returns the number of messages delivered.
    pub fn forward_pending(&self) -> Result<usize, SpoolError> {
        let mut delivered = 0;
        for entry in self.spool.entries()? {
            let data = self.spool.load_message(entry.id)?;
            match self
                .client
                .deliver(&entry.meta.sender, &entry.meta.dovecot_recipient, &data)
            {
                Ok(()) => {
                    self.spool.remove(entry.id)?;
                    delivered += 1;
                    let message = Message {
                        id: entry.meta.message_id,
                        alias_ids: entry.meta.alias_ids.clone(),
                        primary_received: entry.meta.primary_received,
                        sender: entry.meta.sender.clone(),
                        subject: entry.meta.subject.clone(),
                        received_at: entry.meta.received_at,
                        route: entry.meta.route,
                    };
                    if let Ok(service) = self.service.lock() {
                        if let Err(error) = service.record_delivery(&message) {
                            eprintln!("wickmail: provenance recording failed: {error}");
                        }
                    }
                }
                Err(error) => {
                    let mut meta = entry.meta.clone();
                    meta.attempts += 1;
                    let _ = self.spool.update_meta(&meta);
                    eprintln!(
                        "wickmail: forwarding {} failed (attempt {}): {error}",
                        entry.id, meta.attempts
                    );
                }
            }
        }
        Ok(delivered)
    }
}

impl MessageHandler for MailPath {
    fn handle(&self, envelope: Envelope) -> Vec<RecipientReply> {
        self.process(envelope)
    }
}

/// The trusted header value for a route.
pub fn route_header_value(route: Route) -> &'static str {
    match route {
        Route::Inbox => "Inbox",
        Route::Spam => "Spam",
        Route::Quarantine => "Quarantine",
    }
}

fn annotate(
    message: &mut MessageParts,
    planned: &PlannedDelivery,
    route: Route,
    received_at: crate::timestamp::Timestamp,
) {
    message
        .headers
        .push("X-Wickmail-Message-ID", planned.message_id.to_string());
    for alias_id in &planned.alias_ids {
        message
            .headers
            .push("X-Wickmail-Alias-ID", alias_id.to_string());
    }
    message
        .headers
        .push("X-Wickmail-Route", route_header_value(route));
    message
        .headers
        .push("X-Wickmail-Received-At", received_at.to_string());
}

/// Starts the inbound mail path and blocks until the process is stopped.
pub fn serve(config: ServerConfig) -> Result<(), RuntimeError> {
    let mut store = Store::open(&config.db_path)?;
    store.migrate()?;
    let service = Arc::new(Mutex::new(AliasService::new(
        store,
        AliasGenerator::new(),
        config.domain.clone(),
        Arc::new(SystemClock) as SharedClock,
    )));
    let policy = Arc::new(RecipientPolicy::new(
        config.primary.clone(),
        service.clone(),
    ));
    let spool = Arc::new(Spool::open(&config.spool_dir, config.max_spool_entries)?);
    let client = Arc::new(LmtpClient::new(
        config.dovecot_lmtp.clone(),
        config.hostname.clone(),
    ));
    let path = Arc::new(MailPath::new(
        policy.clone(),
        spool.clone(),
        client,
        service,
        config.primary.clone(),
        Arc::new(SystemClock) as SharedClock,
    ));

    let policy_listener = socketmap::bind(&config.policy_socket)?;
    {
        let policy = policy.clone();
        let name = config.socketmap_name.clone();
        std::thread::spawn(move || {
            for stream in policy_listener.incoming().flatten() {
                let policy = policy.clone();
                let name = name.clone();
                std::thread::spawn(move || {
                    let _ = socketmap::serve_connection(stream, &name, &policy);
                });
            }
        });
    }

    let lmtp_listener = bind_lmtp(&config.lmtp_socket)?;
    {
        let path = path.clone();
        std::thread::spawn(move || {
            for stream in lmtp_listener.incoming().flatten() {
                let path = path.clone();
                std::thread::spawn(move || {
                    let _ = serve_session(stream, path.as_ref());
                });
            }
        });
    }

    {
        let path = path.clone();
        std::thread::spawn(move || {
            loop {
                if let Err(error) = path.forward_pending() {
                    eprintln!("wickmail: spool scan failed: {error}");
                }
                if let Ok(stats) = path.spool().stats() {
                    if stats.depth > 0 {
                        eprintln!(
                            "wickmail: spool depth {} oldest age {:?}s",
                            stats.depth, stats.oldest_age_seconds
                        );
                    }
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    }

    // The listeners and worker run on their own threads; keep the process
    // alive until it is signalled.
    loop {
        std::thread::park();
    }
}
