//! UTC timestamps shared by the domain, the database, and the API contract.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// A point in time.
///
/// Timestamps are always stored and evaluated in UTC. The database stores them
/// as epoch milliseconds and the API contract serializes them as RFC 3339
/// strings, for example `2026-01-01T00:00:00Z`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(OffsetDateTime);

impl Timestamp {
    /// The current time in UTC.
    pub fn now() -> Self {
        Self(OffsetDateTime::now_utc())
    }

    /// Wraps an [`OffsetDateTime`] as a timestamp.
    pub fn from_offset_datetime(value: OffsetDateTime) -> Self {
        Self(value)
    }

    /// Builds a timestamp from epoch milliseconds.
    pub fn from_unix_millis(millis: i64) -> Result<Self, time::error::ComponentRange> {
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).map(Self)
    }

    /// The timestamp as epoch milliseconds.
    pub fn unix_millis(self) -> i64 {
        (self.0.unix_timestamp_nanos() / 1_000_000) as i64
    }

    /// Returns the timestamp moved forward by `duration`, or `None` on overflow.
    pub fn checked_add(self, duration: time::Duration) -> Option<Self> {
        self.0.checked_add(duration).map(Self)
    }

    /// The underlying [`OffsetDateTime`].
    pub fn offset_datetime(self) -> OffsetDateTime {
        self.0
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0.format(&Rfc3339) {
            Ok(text) => f.write_str(&text),
            Err(_) => write!(f, "{}", self.0.unix_timestamp()),
        }
    }
}

impl FromStr for Timestamp {
    type Err = time::error::Parse;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        OffsetDateTime::parse(value, &Rfc3339).map(Self)
    }
}

impl Serialize for Timestamp {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        time::serde::rfc3339::serialize(&self.0, serializer)
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        time::serde::rfc3339::deserialize(deserializer).map(Self)
    }
}

impl rusqlite::types::FromSql for Timestamp {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let millis = value.as_i64()?;
        Timestamp::from_unix_millis(millis)
            .map_err(|error| rusqlite::types::FromSqlError::Other(Box::new(error)))
    }
}

impl rusqlite::types::ToSql for Timestamp {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::from(self.unix_millis()))
    }
}

#[cfg(test)]
mod tests {
    use super::Timestamp;

    #[test]
    fn round_trips_through_epoch_millis() {
        let value: Timestamp = "2026-01-01T00:00:00Z".parse().unwrap();
        assert_eq!(value.unix_millis(), 1_767_225_600_000);
        assert_eq!(
            Timestamp::from_unix_millis(value.unix_millis()).unwrap(),
            value
        );
    }

    #[test]
    fn serializes_as_rfc3339_utc() {
        let value: Timestamp = "2026-01-01T00:00:00Z".parse().unwrap();
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            "\"2026-01-01T00:00:00Z\""
        );
        assert_eq!(value.to_string(), "2026-01-01T00:00:00Z");
    }

    #[test]
    fn rejects_invalid_input() {
        assert!("not a timestamp".parse::<Timestamp>().is_err());
    }
}
