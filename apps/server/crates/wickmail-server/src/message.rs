//! Message identity, delivery metadata, and reply provenance.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::alias::AliasId;
use crate::timestamp::Timestamp;

/// Stable message identity, carried as `X-Wickmail-Message-ID`.
///
/// Uses a UUIDv7 so identifiers are sortable by creation time and survive
/// mailbox moves and rebuilds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MessageId(Uuid);

impl MessageId {
    /// Generates a new UUIDv7 message identifier.
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    /// Wraps an existing UUID.
    pub fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    /// The underlying UUID.
    pub fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl Default for MessageId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for MessageId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for MessageId {
    type Err = uuid::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value).map(Self)
    }
}

impl rusqlite::types::FromSql for MessageId {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let text = value.as_str()?;
        MessageId::from_str(text)
            .map_err(|error| rusqlite::types::FromSqlError::Other(Box::new(error)))
    }
}

impl rusqlite::types::ToSql for MessageId {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::from(self.0.to_string()))
    }
}

/// Where a delivered message is routed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    /// Delivered to the inbox.
    Inbox,
    /// Classified as spam.
    Spam,
    /// Held for an expired alias.
    Quarantine,
}

/// The trusted set of recipients recorded at inbound acceptance.
///
/// Envelope recipients are authoritative and include blind copies. Provenance
/// is stored as alias IDs plus whether the primary address received the
/// message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// Aliases that received the message.
    pub alias_ids: Vec<AliasId>,
    /// Whether the primary address received the message.
    pub primary_received: bool,
}

impl Provenance {
    /// Selects the default reply identity for this provenance.
    ///
    /// Exactly one alias selects that alias even when the primary address also
    /// received the message. Multiple aliases require an explicit choice.
    pub fn reply_identity(&self) -> ReplyIdentity {
        match self.alias_ids.as_slice() {
            [] if self.primary_received => ReplyIdentity::Primary,
            [] => ReplyIdentity::None,
            [alias] => ReplyIdentity::Alias(*alias),
            _ => ReplyIdentity::Ambiguous,
        }
    }
}

/// The reply identity implied by provenance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyIdentity {
    /// Exactly one alias received the message.
    Alias(AliasId),
    /// Only the primary address received the message.
    Primary,
    /// Several aliases received the message; the user must choose.
    Ambiguous,
    /// No recipient is recorded.
    None,
}

/// Delivery metadata for an accepted message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// Stable message identity.
    pub id: MessageId,
    /// Aliases that received the message.
    pub alias_ids: Vec<AliasId>,
    /// Whether the primary address received the message.
    pub primary_received: bool,
    /// Envelope sender.
    pub sender: String,
    /// Subject line, retained only for the delivery-metadata window.
    pub subject: String,
    /// When the message was accepted.
    pub received_at: Timestamp,
    /// Trusted route.
    pub route: Route,
}

#[cfg(test)]
mod tests {
    use super::{MessageId, Provenance, ReplyIdentity};
    use crate::alias::AliasId;

    fn alias(value: &str) -> AliasId {
        AliasId::from_uuid(value.parse().unwrap())
    }

    #[test]
    fn message_id_is_uuid_v7() {
        let id = MessageId::new();
        assert_eq!(id.as_uuid().get_version_num(), 7);
    }

    #[test]
    fn single_alias_is_the_default_reply_identity() {
        let first = alias("018f9b60-0000-7000-8000-000000000001");
        let provenance = Provenance {
            alias_ids: vec![first],
            primary_received: true,
        };
        assert_eq!(provenance.reply_identity(), ReplyIdentity::Alias(first));
    }

    #[test]
    fn multiple_aliases_are_ambiguous() {
        let provenance = Provenance {
            alias_ids: vec![
                alias("018f9b60-0000-7000-8000-000000000001"),
                alias("018f9b60-0000-7000-8000-000000000002"),
            ],
            primary_received: false,
        };
        assert_eq!(provenance.reply_identity(), ReplyIdentity::Ambiguous);
    }

    #[test]
    fn primary_only_selects_the_primary_identity() {
        let provenance = Provenance {
            alias_ids: Vec::new(),
            primary_received: true,
        };
        assert_eq!(provenance.reply_identity(), ReplyIdentity::Primary);
    }
}
