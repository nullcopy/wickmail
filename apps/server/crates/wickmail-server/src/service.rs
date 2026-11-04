//! Alias lifecycle service.
//!
//! `AliasService` combines generation, canonical lookup, lease evaluation, and
//! audit recording. Later milestones build the mail path and HTTP API on these
//! entry points.

use thiserror::Error;
use time::Duration;

use crate::address::Domain;
use crate::alias::{Alias, AliasId, DEFAULT_LEASE_SECONDS};
use crate::api::{CreateAliasRequest, ExpiryRequest, UpdateAliasRequest};
use crate::audit::{AuditDetail, AuditEvent, AuditEventKind};
use crate::clock::{SharedClock, SystemClock};
use crate::db::{Store, StoreError};
use crate::generator::{AliasGenerator, GenerateError};
use crate::lease::{
    LeaseError, ManualAction, OutboundDecision, apply_manual_action, apply_outbound,
    evaluate_state, record_inbound,
};
use crate::message::MessageId;
use crate::timestamp::Timestamp;

/// Initial expiration choice for a new alias.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExpiryChoice {
    /// Start with a lease relative to creation; `None` uses the default.
    LeaseSeconds(Option<i64>),
    /// Start with an absolute expiry.
    Absolute(Timestamp),
    /// Start with no expiry.
    Never,
}

/// Input for creating an alias.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateAlias {
    /// User-facing name.
    pub label: Option<String>,
    /// Optional order, merchant, or notes field.
    pub purpose: Option<String>,
    /// Initial expiration.
    pub expiry: ExpiryChoice,
    /// Whether authenticated outbound mail renews the lease.
    pub renew_on_outbound: bool,
}

impl Default for CreateAlias {
    fn default() -> Self {
        Self {
            label: None,
            purpose: None,
            expiry: ExpiryChoice::LeaseSeconds(None),
            renew_on_outbound: true,
        }
    }
}

impl From<CreateAliasRequest> for CreateAlias {
    fn from(request: CreateAliasRequest) -> Self {
        let expiry = match request.expiry {
            None => ExpiryChoice::LeaseSeconds(None),
            Some(ExpiryRequest::Lease { seconds }) => ExpiryChoice::LeaseSeconds(seconds),
            Some(ExpiryRequest::Absolute { expires_at }) => ExpiryChoice::Absolute(expires_at),
            Some(ExpiryRequest::Never) => ExpiryChoice::Never,
        };
        Self {
            label: request.label,
            purpose: request.purpose,
            expiry,
            renew_on_outbound: request.renew_on_outbound.unwrap_or(true),
        }
    }
}

/// The outcome of an authenticated outbound submission.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboundOutcome {
    /// Whether the submission was accepted and whether it renewed the lease.
    pub decision: OutboundDecision,
    /// The alias after evaluation.
    pub alias: Alias,
}

/// Service failures.
#[derive(Debug, Error)]
pub enum ServiceError {
    /// Storage failure.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// Address generation failure.
    #[error(transparent)]
    Generate(#[from] GenerateError),
    /// Lease rule violation.
    #[error(transparent)]
    Lease(#[from] LeaseError),
    /// The alias does not exist.
    #[error("alias not found: {0}")]
    NotFound(AliasId),
    /// The requested expiry is invalid.
    #[error("invalid expiry: {0}")]
    InvalidExpiry(String),
}

/// Generates, evaluates, and records aliases.
pub struct AliasService {
    store: Store,
    generator: AliasGenerator,
    domain: Domain,
    clock: SharedClock,
}

impl AliasService {
    /// Creates a service over an existing store and clock.
    pub fn new(
        store: Store,
        generator: AliasGenerator,
        domain: Domain,
        clock: SharedClock,
    ) -> Self {
        Self {
            store,
            generator,
            domain,
            clock,
        }
    }

    /// Creates a service with the curated generator and the wall clock.
    pub fn with_system_clock(store: Store, domain: Domain) -> Self {
        Self::new(
            store,
            AliasGenerator::new(),
            domain,
            std::sync::Arc::new(SystemClock),
        )
    }

    /// The underlying store.
    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Mutable access to the store, for migrations and maintenance.
    pub fn store_mut(&mut self) -> &mut Store {
        &mut self.store
    }

    /// The configured alias domain.
    pub fn domain(&self) -> &Domain {
        &self.domain
    }

    /// Creates an alias with a generated, unique address.
    pub fn create(&self, request: CreateAlias) -> Result<Alias, ServiceError> {
        let now = self.clock.now();
        let (lease_seconds, expires_at) = match request.expiry {
            ExpiryChoice::LeaseSeconds(seconds) => {
                let seconds = seconds.unwrap_or(DEFAULT_LEASE_SECONDS);
                if seconds <= 0 {
                    return Err(ServiceError::InvalidExpiry(
                        "lease duration must be positive".to_string(),
                    ));
                }
                let expires_at = now
                    .checked_add(Duration::seconds(seconds))
                    .ok_or_else(|| ServiceError::InvalidExpiry("lease overflows".to_string()))?;
                (seconds, Some(expires_at))
            }
            ExpiryChoice::Absolute(expires_at) => (DEFAULT_LEASE_SECONDS, Some(expires_at)),
            ExpiryChoice::Never => (DEFAULT_LEASE_SECONDS, None),
        };

        let mut store_error = None;
        let address = self.generator.generate(&self.domain, |candidate| {
            match self.store.address_exists(candidate) {
                Ok(exists) => exists,
                Err(error) => {
                    store_error = Some(error);
                    true
                }
            }
        });
        if let Some(error) = store_error {
            return Err(ServiceError::Store(error));
        }
        let address = address?;

        let alias = Alias {
            id: AliasId::new(),
            address,
            label: request.label,
            purpose: request.purpose,
            created_at: now,
            expires_at,
            disabled_at: None,
            lease_duration_seconds: lease_seconds,
            renew_on_outbound: request.renew_on_outbound,
            last_inbound_at: None,
            last_user_activity_at: None,
            policy_version: 0,
        };
        self.store.insert_alias(&alias)?;
        self.record(
            &alias,
            AuditEventKind::Created,
            Some(AuditDetail {
                previous_expires_at: None,
                expires_at: alias.expires_at,
                lease_seconds: Some(lease_seconds),
                message_id: None,
            }),
            now,
        )?;
        Ok(alias)
    }

    /// Loads an alias by identifier.
    pub fn get(&self, id: AliasId) -> Result<Option<Alias>, ServiceError> {
        self.store.get_alias(id).map_err(ServiceError::from)
    }

    /// Lists all aliases in a deterministic order.
    pub fn list(&self) -> Result<Vec<Alias>, ServiceError> {
        self.store.list_aliases().map_err(ServiceError::from)
    }

    /// Lists an alias's audit events, oldest first.
    pub fn events(&self, id: AliasId) -> Result<Vec<AuditEvent>, ServiceError> {
        self.store.list_audit_events(id).map_err(ServiceError::from)
    }

    /// Evaluates an alias's effective state at the current time.
    pub fn evaluate(&self, id: AliasId) -> Result<crate::alias::AliasState, ServiceError> {
        let alias = self
            .store
            .get_alias(id)?
            .ok_or(ServiceError::NotFound(id))?;
        Ok(evaluate_state(&alias, self.clock.now()))
    }

    /// Renews an alias to `now + seconds`, or `now + lease_duration`.
    pub fn renew(&self, id: AliasId, seconds: Option<i64>) -> Result<Alias, ServiceError> {
        self.mutate(id, |alias, now| {
            apply_manual_action(alias, ManualAction::Renew { seconds }, now)
        })
    }

    /// Extends an unexpired lease from the later of now and its expiry.
    pub fn extend(&self, id: AliasId, seconds: Option<i64>) -> Result<Alias, ServiceError> {
        self.mutate(id, |alias, now| {
            apply_manual_action(alias, ManualAction::Extend { seconds }, now)
        })
    }

    /// Sets an absolute expiry without changing `lease_duration`.
    pub fn set_expiry(&self, id: AliasId, expires_at: Timestamp) -> Result<Alias, ServiceError> {
        self.mutate(id, |alias, now| {
            apply_manual_action(alias, ManualAction::SetExpiry { expires_at }, now)
        })
    }

    /// Removes the expiry without changing `lease_duration`.
    pub fn remove_expiry(&self, id: AliasId) -> Result<Alias, ServiceError> {
        self.mutate(id, |alias, now| {
            apply_manual_action(alias, ManualAction::RemoveExpiry, now)
        })
    }

    /// Disables an alias. The lease is unchanged.
    pub fn disable(&self, id: AliasId) -> Result<Alias, ServiceError> {
        self.mutate(id, |alias, now| {
            apply_manual_action(alias, ManualAction::Disable, now)
        })
    }

    /// Enables a disabled alias and starts a new lease.
    pub fn enable(
        &self,
        id: AliasId,
        expires_at: Option<Timestamp>,
    ) -> Result<Alias, ServiceError> {
        self.mutate(id, |alias, now| {
            apply_manual_action(alias, ManualAction::Enable { expires_at }, now)
        })
    }

    /// Edits label, purpose, and renewal policy.
    ///
    /// These edits never update `last_user_activity_at`.
    pub fn update_metadata(
        &self,
        id: AliasId,
        update: UpdateAliasRequest,
    ) -> Result<Alias, ServiceError> {
        let mut alias = self
            .store
            .get_alias(id)?
            .ok_or(ServiceError::NotFound(id))?;
        if let Some(label) = update.label {
            alias.label = Some(label);
        }
        if let Some(purpose) = update.purpose {
            alias.purpose = Some(purpose);
        }
        if let Some(renew_on_outbound) = update.renew_on_outbound {
            alias.renew_on_outbound = renew_on_outbound;
        }
        alias.policy_version += 1;
        self.store.update_alias(&alias)?;
        Ok(alias)
    }

    /// Applies an authenticated outbound submission.
    ///
    /// A reply is recorded with `message_id`; a plain outbound message passes
    /// `None`.
    pub fn record_outbound(
        &self,
        id: AliasId,
        message_id: Option<MessageId>,
    ) -> Result<OutboundOutcome, ServiceError> {
        let now = self.clock.now();
        let mut alias = self
            .store
            .get_alias(id)?
            .ok_or(ServiceError::NotFound(id))?;
        let previous_expires_at = alias.expires_at;
        let decision = apply_outbound(&mut alias, now);

        if matches!(
            decision,
            OutboundDecision::RejectDisabled | OutboundDecision::RejectExpired
        ) {
            return Ok(OutboundOutcome { decision, alias });
        }

        alias.policy_version += 1;
        self.store.update_alias(&alias)?;

        if decision == OutboundDecision::AcceptRenew {
            self.record(
                &alias,
                AuditEventKind::RenewedByOutbound,
                Some(lease_detail(
                    previous_expires_at,
                    alias.expires_at,
                    alias.lease_duration_seconds,
                )),
                now,
            )?;
        }
        if let Some(message_id) = message_id {
            self.record(
                &alias,
                AuditEventKind::RepliedAsAlias,
                Some(AuditDetail {
                    previous_expires_at: None,
                    expires_at: alias.expires_at,
                    lease_seconds: None,
                    message_id: Some(message_id),
                }),
                now,
            )?;
        }
        Ok(OutboundOutcome { decision, alias })
    }

    /// Records accepted inbound mail. Informational only; never renews.
    pub fn record_inbound(&self, id: AliasId, at: Timestamp) -> Result<Alias, ServiceError> {
        let mut alias = self
            .store
            .get_alias(id)?
            .ok_or(ServiceError::NotFound(id))?;
        record_inbound(&mut alias, at);
        alias.policy_version += 1;
        self.store.update_alias(&alias)?;
        Ok(alias)
    }

    fn mutate<F>(&self, id: AliasId, action: F) -> Result<Alias, ServiceError>
    where
        F: FnOnce(&mut Alias, Timestamp) -> Result<Vec<AuditEventKind>, LeaseError>,
    {
        let now = self.clock.now();
        let mut alias = self
            .store
            .get_alias(id)?
            .ok_or(ServiceError::NotFound(id))?;
        let previous_expires_at = alias.expires_at;
        let events = action(&mut alias, now)?;
        alias.policy_version += 1;
        self.store.update_alias(&alias)?;
        for kind in events {
            let detail = match kind {
                AuditEventKind::ManuallyRenewed
                | AuditEventKind::ManuallyExtended
                | AuditEventKind::ExpirySet
                | AuditEventKind::ExpiryRemoved
                | AuditEventKind::Enabled => Some(lease_detail(
                    previous_expires_at,
                    alias.expires_at,
                    alias.lease_duration_seconds,
                )),
                _ => None,
            };
            self.record(&alias, kind, detail, now)?;
        }
        Ok(alias)
    }

    fn record(
        &self,
        alias: &Alias,
        kind: AuditEventKind,
        detail: Option<AuditDetail>,
        now: Timestamp,
    ) -> Result<(), ServiceError> {
        let event = AuditEvent::new(alias.id, kind, detail, now);
        self.store.insert_audit_event(&event)?;
        Ok(())
    }
}

fn lease_detail(
    previous_expires_at: Option<Timestamp>,
    expires_at: Option<Timestamp>,
    lease_seconds: i64,
) -> AuditDetail {
    AuditDetail {
        previous_expires_at,
        expires_at,
        lease_seconds: Some(lease_seconds),
        message_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{AliasService, CreateAlias, ExpiryChoice, ServiceError};
    use crate::address::Domain;
    use crate::alias::{AliasState, DEFAULT_LEASE_SECONDS};
    use crate::api::UpdateAliasRequest;
    use crate::audit::AuditEventKind;
    use crate::clock::FixedClock;
    use crate::db::Store;
    use crate::generator::AliasGenerator;
    use crate::lease::OutboundDecision;
    use crate::message::MessageId;
    use crate::timestamp::Timestamp;
    use std::sync::Arc;

    fn at(value: &str) -> Timestamp {
        value.parse().unwrap()
    }

    fn service_at(now: &str) -> AliasService {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        AliasService::new(
            store,
            AliasGenerator::new(),
            Domain::parse("example.com").unwrap(),
            Arc::new(FixedClock::new(at(now))),
        )
    }

    #[test]
    fn create_uses_the_default_lease_and_records_an_event() {
        let service = service_at("2026-01-01T00:00:00Z");
        let alias = service.create(CreateAlias::default()).unwrap();
        assert_eq!(alias.expires_at, Some(at("2026-01-08T00:00:00Z")));
        assert_eq!(alias.lease_duration_seconds, DEFAULT_LEASE_SECONDS);
        assert_eq!(alias.policy_version, 0);
        assert_eq!(alias.address.domain(), "example.com");

        let events = service.events(alias.id).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, AuditEventKind::Created);
    }

    #[test]
    fn create_supports_absolute_and_never_expiry() {
        let service = service_at("2026-01-01T00:00:00Z");
        let absolute = service
            .create(CreateAlias {
                expiry: ExpiryChoice::Absolute(at("2027-01-01T00:00:00Z")),
                ..CreateAlias::default()
            })
            .unwrap();
        assert_eq!(absolute.expires_at, Some(at("2027-01-01T00:00:00Z")));
        assert_eq!(absolute.lease_duration_seconds, DEFAULT_LEASE_SECONDS);

        let never = service
            .create(CreateAlias {
                expiry: ExpiryChoice::Never,
                ..CreateAlias::default()
            })
            .unwrap();
        assert_eq!(never.expires_at, None);
    }

    #[test]
    fn create_rejects_a_non_positive_lease() {
        let service = service_at("2026-01-01T00:00:00Z");
        let result = service.create(CreateAlias {
            expiry: ExpiryChoice::LeaseSeconds(Some(0)),
            ..CreateAlias::default()
        });
        assert!(matches!(result, Err(ServiceError::InvalidExpiry(_))));
    }

    #[test]
    fn create_generates_unique_addresses() {
        let service = service_at("2026-01-01T00:00:00Z");
        let mut addresses = std::collections::HashSet::new();
        for _ in 0..64 {
            let alias = service.create(CreateAlias::default()).unwrap();
            assert!(addresses.insert(alias.address.clone()));
        }
    }

    #[test]
    fn create_falls_back_to_a_third_word_on_collisions() {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let service = AliasService::new(
            store,
            AliasGenerator::from_words(vec!["a", "b"]),
            Domain::parse("example.com").unwrap(),
            Arc::new(FixedClock::new(at("2026-01-01T00:00:00Z"))),
        );
        // The four two-word combinations are taken first.
        for _ in 0..4 {
            service.create(CreateAlias::default()).unwrap();
        }
        let alias = service.create(CreateAlias::default()).unwrap();
        assert_eq!(alias.address.local_part().split('.').count(), 3);
    }

    #[test]
    fn renew_persists_and_records_an_event() {
        let service = service_at("2026-01-04T00:00:00Z");
        let alias = service.create(CreateAlias::default()).unwrap();
        let renewed = service.renew(alias.id, None).unwrap();
        assert_eq!(renewed.expires_at, Some(at("2026-01-11T00:00:00Z")));
        assert_eq!(
            renewed.last_user_activity_at,
            Some(at("2026-01-04T00:00:00Z"))
        );
        assert_eq!(renewed.policy_version, 1);

        let events = service.events(alias.id).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].kind, AuditEventKind::ManuallyRenewed);
    }

    #[test]
    fn update_metadata_does_not_touch_user_activity() {
        let service = service_at("2026-01-04T00:00:00Z");
        let alias = service.create(CreateAlias::default()).unwrap();
        let updated = service
            .update_metadata(
                alias.id,
                UpdateAliasRequest {
                    label: Some("Renamed".to_string()),
                    ..UpdateAliasRequest::default()
                },
            )
            .unwrap();
        assert_eq!(updated.label.as_deref(), Some("Renamed"));
        assert_eq!(updated.last_user_activity_at, None);
        assert_eq!(service.events(alias.id).unwrap().len(), 1);
    }

    #[test]
    fn outbound_renewal_records_renewal_and_reply_events() {
        let service = service_at("2026-01-04T00:00:00Z");
        let alias = service.create(CreateAlias::default()).unwrap();
        let message_id = MessageId::new();
        let outcome = service.record_outbound(alias.id, Some(message_id)).unwrap();
        assert_eq!(outcome.decision, OutboundDecision::AcceptRenew);
        assert_eq!(outcome.alias.expires_at, Some(at("2026-01-11T00:00:00Z")));

        let kinds: Vec<_> = service
            .events(alias.id)
            .unwrap()
            .into_iter()
            .map(|event| event.kind)
            .collect();
        assert_eq!(
            kinds,
            vec![
                AuditEventKind::Created,
                AuditEventKind::RenewedByOutbound,
                AuditEventKind::RepliedAsAlias,
            ]
        );
    }

    #[test]
    fn disabled_alias_rejects_outbound_without_changes() {
        let service = service_at("2026-01-04T00:00:00Z");
        let alias = service.create(CreateAlias::default()).unwrap();
        service.disable(alias.id).unwrap();
        let outcome = service.record_outbound(alias.id, None).unwrap();
        assert_eq!(outcome.decision, OutboundDecision::RejectDisabled);
        assert_eq!(service.evaluate(alias.id).unwrap(), AliasState::Disabled);
    }

    #[test]
    fn inbound_records_activity_without_renewing() {
        let service = service_at("2026-01-04T00:00:00Z");
        let alias = service.create(CreateAlias::default()).unwrap();
        let updated = service
            .record_inbound(alias.id, at("2026-01-04T00:00:00Z"))
            .unwrap();
        assert_eq!(updated.last_inbound_at, Some(at("2026-01-04T00:00:00Z")));
        assert_eq!(updated.expires_at, Some(at("2026-01-11T00:00:00Z")));
    }

    #[test]
    fn missing_alias_reports_not_found() {
        let service = service_at("2026-01-04T00:00:00Z");
        let missing = crate::alias::AliasId::new();
        assert!(matches!(
            service.renew(missing, None),
            Err(ServiceError::NotFound(_))
        ));
    }

    #[test]
    fn create_request_converts_expiry_modes() {
        let request = crate::api::CreateAliasRequest {
            label: None,
            purpose: None,
            expiry: Some(crate::api::ExpiryRequest::Never),
            renew_on_outbound: None,
        };
        let create = CreateAlias::from(request);
        assert_eq!(create.expiry, ExpiryChoice::Never);
        assert!(create.renew_on_outbound);
    }
}
