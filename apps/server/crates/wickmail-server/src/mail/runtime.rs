//! Inbound mail path runtime.
//!
//! Wires the RCPT policy socketmap, the LMTP proxy, the durable spool, and the
//! spool worker into one process. The alias database is owned here and shared
//! by the policy lookup and the delivery path through a mutex.

use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use thiserror::Error;

use crate::abuse::{AbusePolicy, AlertKind, Alerter, LogAlerter, RateLimiter};
use crate::address::{CanonicalAddress, Domain};
use crate::clock::{SharedClock, SystemClock};
use crate::db::{Store, StoreError};
use crate::generator::AliasGenerator;
use crate::http::{AppState, HttpConfig, serve_http};
use crate::mail::delivery::{PlannedDelivery, plan};
use crate::mail::headers::{MessageParts, WICKMAIL_HEADER_PREFIX};
use crate::mail::lmtp::{
    Envelope, LmtpClient, LmtpTarget, MessageHandler, RecipientReply, bind as bind_lmtp,
    serve_session,
};
use crate::mail::policy::RecipientPolicy;
use crate::mail::socketmap::{self, DEFAULT_SOCKETMAP_NAME};
use crate::mail::spool::{Spool, SpoolError, SpoolMeta};
use crate::mail::store::MailStoreAdapter;
use crate::mail::submission::{SUBMISSION_SOCKETMAP_NAME, SubmissionPolicy};
use crate::message::{Message, Route};
use crate::quarantine::{QuarantineError, QuarantineManager, RetentionPolicy};
use crate::reply::{DkimSigner, FileOutboundQueue};
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
    /// Unix socket Postfix uses for the outbound submission ownership check.
    pub submission_socket: Option<PathBuf>,
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
    /// Maildir root for the account, when quarantine maintenance is enabled.
    pub maildir: Option<PathBuf>,
    /// Quarantine mailbox directory, when it lives outside the account root.
    pub quarantine_dir: Option<PathBuf>,
    /// Retention windows and quotas for quarantine and spam.
    pub retention: RetentionPolicy,
    /// How often reconciliation and retention run.
    pub maintenance_interval: Duration,
    /// Address the management API listens on, when enabled.
    pub http_listen: Option<SocketAddr>,
    /// Directory holding the built web assets, served from the API origin.
    pub web_root: Option<PathBuf>,
    /// Directory the management API queues outbound replies into.
    pub outbound_dir: Option<PathBuf>,
    /// Inbound abuse policy.
    pub abuse: AbusePolicy,
    /// Whether the management session cookie carries `Secure`.
    pub cookie_secure: bool,
    /// PEM-encoded DKIM key for outbound replies.
    pub dkim_key: Option<PathBuf>,
    /// DKIM selector for outbound replies.
    pub dkim_selector: String,
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
            submission_socket: None,
            lmtp_socket: lmtp_socket.into(),
            dovecot_lmtp,
            spool_dir: spool_dir.into(),
            max_spool_entries: 10_000,
            socketmap_name: DEFAULT_SOCKETMAP_NAME.to_string(),
            hostname: "wickmail".to_string(),
            maildir: None,
            quarantine_dir: None,
            retention: RetentionPolicy::default(),
            maintenance_interval: Duration::from_secs(60),
            http_listen: None,
            web_root: None,
            outbound_dir: None,
            abuse: AbusePolicy::default(),
            cookie_secure: true,
            dkim_key: None,
            dkim_selector: "wickmail".to_string(),
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
    /// The runtime configuration is incomplete or invalid.
    #[error("configuration error: {0}")]
    Config(String),
}

/// Operational counters for the inbound mail path.
///
/// They are the signals the design requires monitoring: policy-service
/// failures, spool exhaustion, and forwarding failures. Counters are
/// process-local and monotonic; the running server logs them alongside spool
/// depth so an operator alert rule can fire on them.
#[derive(Debug, Default)]
pub struct MailMetrics {
    policy_failures: AtomicU64,
    spool_full: AtomicU64,
    spool_unavailable: AtomicU64,
    forwarding_failures: AtomicU64,
    accepted: AtomicU64,
    delivered: AtomicU64,
}

impl MailMetrics {
    /// Reads every counter at one instant.
    pub fn snapshot(&self) -> MailMetricsSnapshot {
        MailMetricsSnapshot {
            policy_failures: self.policy_failures.load(Ordering::Relaxed),
            spool_full: self.spool_full.load(Ordering::Relaxed),
            spool_unavailable: self.spool_unavailable.load(Ordering::Relaxed),
            forwarding_failures: self.forwarding_failures.load(Ordering::Relaxed),
            accepted: self.accepted.load(Ordering::Relaxed),
            delivered: self.delivered.load(Ordering::Relaxed),
        }
    }
}

/// A point-in-time copy of [`MailMetrics`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MailMetricsSnapshot {
    /// Delivery-time policy or database failures.
    pub policy_failures: u64,
    /// Messages rejected because the spool reached its entry limit.
    pub spool_full: u64,
    /// Messages rejected because the spool could not be read or written.
    pub spool_unavailable: u64,
    /// Spool entries that could not be loaded or forwarded.
    pub forwarding_failures: u64,
    /// Messages accepted and written to the spool.
    pub accepted: u64,
    /// Spool entries successfully delivered to Dovecot.
    pub delivered: u64,
}

/// The composed inbound mail path: policy, spool, and Dovecot forwarder.
pub struct MailPath {
    policy: Arc<RecipientPolicy>,
    spool: Arc<Spool>,
    client: Arc<LmtpClient>,
    service: Arc<Mutex<AliasService>>,
    primary: CanonicalAddress,
    clock: SharedClock,
    adapter: Option<Arc<MailStoreAdapter>>,
    retention: RetentionPolicy,
    metrics: MailMetrics,
    abuse: AbusePolicy,
    limiter: Arc<RateLimiter>,
    alerter: Arc<dyn Alerter>,
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
            adapter: None,
            retention: RetentionPolicy::default(),
            metrics: MailMetrics::default(),
            abuse: AbusePolicy::default(),
            limiter: Arc::new(RateLimiter::new()),
            alerter: Arc::new(LogAlerter),
        }
    }

    /// Enables quarantine reconciliation and retention over the mail store.
    pub fn enable_maintenance(&mut self, adapter: MailStoreAdapter, retention: RetentionPolicy) {
        self.enable_maintenance_with(Arc::new(adapter), retention);
    }

    /// Enables maintenance over a shared mail-store adapter.
    pub fn enable_maintenance_with(
        &mut self,
        adapter: Arc<MailStoreAdapter>,
        retention: RetentionPolicy,
    ) {
        self.adapter = Some(adapter);
        self.retention = retention;
    }

    /// Applies the inbound abuse policy, rate limiter, and alert sink.
    pub fn with_abuse(
        &mut self,
        abuse: AbusePolicy,
        limiter: Arc<RateLimiter>,
        alerter: Arc<dyn Alerter>,
    ) {
        self.abuse = abuse;
        self.limiter = limiter;
        self.alerter = alerter;
    }

    /// The durable spool.
    pub fn spool(&self) -> &Arc<Spool> {
        &self.spool
    }

    /// A snapshot of the operational counters.
    pub fn metrics(&self) -> MailMetricsSnapshot {
        self.metrics.snapshot()
    }

    /// Reconciles quarantine membership and enforces retention.
    ///
    /// Reconciliation repairs a crash or restore, then retention deletes
    /// time-expired and over-quota messages oldest first. Messages in
    /// `recovering` or `deleting` are never deleted.
    pub fn maintain(&self) -> Result<(), QuarantineError> {
        let Some(adapter) = &self.adapter else {
            return Ok(());
        };
        let Ok(service) = self.service.lock() else {
            return Ok(());
        };
        let manager =
            QuarantineManager::new(service.store(), adapter, self.retention, self.clock.clone());
        let reconciliation = manager.reconcile()?;
        if reconciliation.metadata_rebuilt > 0
            || reconciliation.completed_recoveries > 0
            || reconciliation.completed_deletions > 0
            || reconciliation.restored_to_quarantine > 0
        {
            eprintln!(
                "wickmail: quarantine reconciliation repaired {} rebuilt {} recovered {} deleted {} requeued {}",
                reconciliation.scanned,
                reconciliation.metadata_rebuilt,
                reconciliation.completed_recoveries,
                reconciliation.completed_deletions,
                reconciliation.restored_to_quarantine,
            );
        }
        let retention = manager.retention_sweep()?;
        if retention.deleted > 0 || retention.purged > 0 {
            eprintln!(
                "wickmail: quarantine retention deleted {} purged {}",
                retention.deleted, retention.purged,
            );
        }
        let quotas = manager.enforce_quotas(
            self.abuse.per_alias_quarantine_count,
            self.abuse.per_alias_quarantine_bytes,
        )?;
        if quotas > 0 {
            self.alerter.alert(
                AlertKind::QuotaExceeded,
                &format!("deleted {quotas} over-quota quarantined messages"),
            );
        }
        Ok(())
    }

    /// Evaluates an envelope, annotates it with trusted headers, and spools it.
    pub fn process(&self, envelope: Envelope) -> Vec<RecipientReply> {
        let count = envelope.recipients.len();

        if self.abuse.rejects_size(envelope.data.len()) {
            self.alerter.alert(
                AlertKind::QuotaExceeded,
                "inbound message exceeds the maximum size",
            );
            return vec![
                RecipientReply {
                    code: 552,
                    text: "5.3.4 message too big".to_string(),
                };
                count
            ];
        }
        if let Some(limit) = self.abuse.per_sender
            && let Err(limited) = self
                .limiter
                .check(&envelope.sender, limit, self.clock.now())
        {
            self.alerter
                .alert(AlertKind::RateLimited, "per-sender rate limit reached");
            return vec![
                RecipientReply::temporary(format!(
                    "4.7.1 rate limited, retry in {}s",
                    limited.retry_after_seconds
                ));
                count
            ];
        }
        if let Some(limit) = self.abuse.global
            && let Err(limited) = self.limiter.check_global(limit, self.clock.now())
        {
            self.alerter
                .alert(AlertKind::RateLimited, "global rate limit reached");
            return vec![
                RecipientReply::temporary(format!(
                    "4.7.1 rate limited, retry in {}s",
                    limited.retry_after_seconds
                ));
                count
            ];
        }

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
                self.metrics.policy_failures.fetch_add(1, Ordering::Relaxed);
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
                self.metrics.accepted.fetch_add(1, Ordering::Relaxed);
                vec![
                    RecipientReply::accepted(format!("2.0.0 Ok: queued as {}", planned.message_id));
                    count
                ]
            }
            Err(error) => {
                if matches!(error, SpoolError::Full { .. }) {
                    self.metrics.spool_full.fetch_add(1, Ordering::Relaxed);
                } else {
                    self.metrics
                        .spool_unavailable
                        .fetch_add(1, Ordering::Relaxed);
                }
                let disk_full =
                    matches!(&error, SpoolError::Io(io) if crate::abuse::is_disk_full(io));
                self.alerter.alert(
                    if disk_full {
                        AlertKind::DiskFull
                    } else {
                        AlertKind::SpoolFailure
                    },
                    &error.to_string(),
                );
                eprintln!("wickmail: spool unavailable: {error}");
                vec![RecipientReply::temporary("4.3.0 spool unavailable"); count]
            }
        }
    }

    /// Forwards every spooled message to Dovecot, recording provenance on
    /// success. Returns the number of messages delivered.
    ///
    /// A failure on one entry — an unreadable body, a failed removal, or a
    /// rejected delivery — is recorded and skipped so it cannot block the
    /// entries behind it. The failed entry stays in the spool and is retried.
    pub fn forward_pending(&self) -> Result<usize, SpoolError> {
        let mut delivered = 0;
        for entry in self.spool.entries()? {
            let data = match self.spool.load_message(entry.id) {
                Ok(data) => data,
                Err(error) => {
                    self.metrics
                        .forwarding_failures
                        .fetch_add(1, Ordering::Relaxed);
                    eprintln!("wickmail: spool entry {} unreadable: {error}", entry.id);
                    continue;
                }
            };
            match self
                .client
                .deliver(&entry.meta.sender, &entry.meta.dovecot_recipient, &data)
            {
                Ok(()) => {
                    if let Err(error) = self.spool.remove(entry.id) {
                        self.metrics
                            .forwarding_failures
                            .fetch_add(1, Ordering::Relaxed);
                        eprintln!(
                            "wickmail: delivered {} but could not clear it from the spool: {error}",
                            entry.id
                        );
                        continue;
                    }
                    delivered += 1;
                    self.metrics.delivered.fetch_add(1, Ordering::Relaxed);
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
                        if let Some(adapter) = &self.adapter {
                            let manager = QuarantineManager::new(
                                service.store(),
                                adapter.as_ref(),
                                self.retention,
                                self.clock.clone(),
                            );
                            match manager.enforce_quotas(
                                self.abuse.per_alias_quarantine_count,
                                self.abuse.per_alias_quarantine_bytes,
                            ) {
                                Ok(deleted) if deleted > 0 => self.alerter.alert(
                                    AlertKind::QuotaExceeded,
                                    &format!("deleted {deleted} over-quota quarantined messages"),
                                ),
                                Ok(_) => {}
                                Err(error) => {
                                    eprintln!("wickmail: quota enforcement failed: {error}");
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    self.metrics
                        .forwarding_failures
                        .fetch_add(1, Ordering::Relaxed);
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

/// Starts the management API on its own thread.
fn start_http(
    config: &ServerConfig,
    listen: SocketAddr,
    service: Arc<Mutex<AliasService>>,
    adapter: Option<Arc<MailStoreAdapter>>,
) -> Result<(), RuntimeError> {
    let mail = adapter
        .ok_or_else(|| RuntimeError::Config("--http-listen requires --maildir".to_string()))?;
    let outbound_dir = config
        .outbound_dir
        .clone()
        .ok_or_else(|| RuntimeError::Config("--http-listen requires --outbound-dir".to_string()))?;
    let queue = Arc::new(
        FileOutboundQueue::open(&outbound_dir)
            .map_err(|error| RuntimeError::Config(error.to_string()))?,
    );

    let mut http_config = HttpConfig::new(config.domain.clone(), Some(config.primary.clone()));
    http_config.web_root = config.web_root.clone();
    http_config.cookie_secure = config.cookie_secure;

    let mut state = AppState::new(
        service,
        mail,
        queue,
        http_config,
        Arc::new(SystemClock) as SharedClock,
    );
    if let Some(key) = &config.dkim_key {
        let pem = std::fs::read_to_string(key).map_err(|error| {
            RuntimeError::Config(format!("cannot read DKIM key {}: {error}", key.display()))
        })?;
        let signer =
            DkimSigner::from_pem(config.domain.clone(), config.dkim_selector.clone(), &pem)
                .map_err(|error| RuntimeError::Config(error.to_string()))?;
        state = state.with_dkim(Arc::new(signer));
    }

    #[cfg(feature = "passkeys")]
    {
        if let Ok(webauthn) = crate::http::build_webauthn(&state.config) {
            state = state.with_webauthn(Arc::new(webauthn));
        }
    }

    std::thread::spawn(move || {
        if let Err(error) = serve_http(state, listen) {
            eprintln!("wickmail: management API failed: {error}");
        }
    });
    Ok(())
}

/// Starts the inbound mail path and blocks until the process is stopped.
pub fn serve(config: ServerConfig) -> Result<(), RuntimeError> {
    let mut store = Store::open(&config.db_path)?;
    store.migrate()?;
    let service = Arc::new(Mutex::new(
        AliasService::new(
            store,
            AliasGenerator::new(),
            config.domain.clone(),
            Arc::new(SystemClock) as SharedClock,
        )
        .with_retention(config.retention),
    ));
    let http_service = service.clone();
    let policy = Arc::new(RecipientPolicy::new(
        config.primary.clone(),
        service.clone(),
    ));
    let spool = Arc::new(Spool::open(&config.spool_dir, config.max_spool_entries)?);
    let client = Arc::new(LmtpClient::new(
        config.dovecot_lmtp.clone(),
        config.hostname.clone(),
    ));
    if let Some(submission_socket) = &config.submission_socket {
        let submission = Arc::new(SubmissionPolicy::new(
            config.primary.clone(),
            service.clone(),
        ));
        let listener = socketmap::bind(submission_socket)?;
        let name = SUBMISSION_SOCKETMAP_NAME.to_string();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let submission = submission.clone();
                let name = name.clone();
                std::thread::spawn(move || {
                    let _ = socketmap::serve_connection_with(stream, |payload| {
                        submission.reply_for(&name, payload)
                    });
                });
            }
        });
    }

    let mut path = MailPath::new(
        policy.clone(),
        spool.clone(),
        client,
        service,
        config.primary.clone(),
        Arc::new(SystemClock) as SharedClock,
    );
    let adapter = config.maildir.as_ref().map(|maildir| {
        Arc::new(match &config.quarantine_dir {
            Some(quarantine_dir) => MailStoreAdapter::with_quarantine(maildir, quarantine_dir),
            None => MailStoreAdapter::open(maildir),
        })
    });
    if let Some(adapter) = &adapter {
        path.enable_maintenance_with(adapter.clone(), config.retention);
    }
    path.with_abuse(
        config.abuse,
        Arc::new(RateLimiter::new()),
        Arc::new(LogAlerter),
    );
    let path = Arc::new(path);

    if let Some(listen) = config.http_listen {
        start_http(&config, listen, http_service, adapter)?;
        eprintln!("wickmail: management API listening on {listen}");
    }

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
            let mut reported = MailMetricsSnapshot::default();
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
                let metrics = path.metrics();
                if metrics != reported {
                    eprintln!(
                        "wickmail: metrics policy_failures={} spool_full={} spool_unavailable={} forwarding_failures={} accepted={} delivered={}",
                        metrics.policy_failures,
                        metrics.spool_full,
                        metrics.spool_unavailable,
                        metrics.forwarding_failures,
                        metrics.accepted,
                        metrics.delivered,
                    );
                    reported = metrics;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    }

    if config.maildir.is_some() {
        if let Err(error) = path.maintain() {
            eprintln!("wickmail: startup quarantine maintenance failed: {error}");
        }
        let path = path.clone();
        let interval = config.maintenance_interval;
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(interval);
                if let Err(error) = path.maintain() {
                    eprintln!("wickmail: quarantine maintenance failed: {error}");
                }
            }
        });
    }

    // The listeners and worker run on their own threads; keep the process
    // alive until it is signalled.
    loop {
        std::thread::park();
    }
}
