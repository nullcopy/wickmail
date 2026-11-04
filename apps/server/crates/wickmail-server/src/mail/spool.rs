//! Durable spool with acknowledge-after-spool semantics.
//!
//! A message is written to disk and flushed before the LMTP proxy acknowledges
//! it. A background worker retries forwarding to Dovecot; a delivery failure
//! leaves the entry in the spool rather than bouncing. Spool depth and age are
//! exposed for monitoring.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::alias::AliasId;
use crate::message::{MessageId, Route};
use crate::timestamp::Timestamp;

/// Metadata stored alongside a spooled message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolMeta {
    /// Stable message identity.
    pub message_id: MessageId,
    /// Envelope sender.
    pub sender: String,
    /// Envelope recipient used when forwarding to Dovecot.
    pub dovecot_recipient: String,
    /// Aliases that received the message.
    pub alias_ids: Vec<AliasId>,
    /// Whether the primary address received the message.
    pub primary_received: bool,
    /// Trusted route.
    pub route: Route,
    /// Subject line, recorded with delivery metadata.
    pub subject: String,
    /// When the message was accepted.
    pub received_at: Timestamp,
    /// Forwarding attempts made so far.
    #[serde(default)]
    pub attempts: u32,
}

/// A spooled entry.
#[derive(Clone, Debug)]
pub struct SpoolEntry {
    /// Message identity.
    pub id: MessageId,
    /// Parsed metadata.
    pub meta: SpoolMeta,
}

/// Spool depth and age.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpoolStats {
    /// Number of messages waiting to be forwarded.
    pub depth: usize,
    /// Age of the oldest message in seconds, or `None` when empty.
    pub oldest_age_seconds: Option<i64>,
}

/// Why a spool operation failed.
#[derive(Debug, Error)]
pub enum SpoolError {
    /// The underlying filesystem call failed.
    #[error(transparent)]
    Io(#[from] io::Error),
    /// The configured maximum spool depth was reached.
    #[error("spool is full: {depth} entries")]
    Full {
        /// Configured maximum.
        depth: usize,
    },
    /// Stored metadata could not be decoded.
    #[error("corrupt spool metadata: {0}")]
    Corrupt(String),
}

/// A directory-backed durable spool.
pub struct Spool {
    dir: PathBuf,
    max_entries: usize,
}

impl Spool {
    /// Opens or creates a spool directory with a maximum entry count.
    pub fn open(dir: impl Into<PathBuf>, max_entries: usize) -> Result<Self, SpoolError> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir, max_entries })
    }

    /// The spool directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Writes a message and its metadata, flushing both before returning.
    pub fn enqueue(&self, message: &[u8], meta: &SpoolMeta) -> Result<(), SpoolError> {
        if self.stats()?.depth >= self.max_entries {
            return Err(SpoolError::Full {
                depth: self.max_entries,
            });
        }
        let id = meta.message_id;
        let message_path = self.message_path(id);
        let meta_path = self.meta_path(id);
        let meta_json =
            serde_json::to_vec(meta).map_err(|error| SpoolError::Corrupt(error.to_string()))?;

        write_atomic(&self.dir, &message_path, message)?;
        if let Err(error) = write_atomic(&self.dir, &meta_path, &meta_json) {
            let _ = std::fs::remove_file(&message_path);
            return Err(error);
        }
        Ok(())
    }

    /// Lists spooled entries ordered by message identity (UUIDv7, oldest first).
    pub fn entries(&self) -> Result<Vec<SpoolEntry>, SpoolError> {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("meta") {
                continue;
            }
            let bytes = std::fs::read(&path)?;
            let meta: SpoolMeta = serde_json::from_slice(&bytes)
                .map_err(|error| SpoolError::Corrupt(error.to_string()))?;
            entries.push(SpoolEntry {
                id: meta.message_id,
                meta,
            });
        }
        entries.sort_by_key(|entry| entry.id);
        Ok(entries)
    }

    /// Loads the raw message bytes for an entry.
    pub fn load_message(&self, id: MessageId) -> Result<Vec<u8>, SpoolError> {
        Ok(std::fs::read(self.message_path(id))?)
    }

    /// Rewrites the metadata for an entry.
    pub fn update_meta(&self, meta: &SpoolMeta) -> Result<(), SpoolError> {
        let json =
            serde_json::to_vec(meta).map_err(|error| SpoolError::Corrupt(error.to_string()))?;
        write_atomic(&self.dir, &self.meta_path(meta.message_id), &json)?;
        Ok(())
    }

    /// Removes an entry's message and metadata.
    pub fn remove(&self, id: MessageId) -> Result<(), SpoolError> {
        remove_if_present(&self.message_path(id))?;
        remove_if_present(&self.meta_path(id))?;
        sync_dir(&self.dir)?;
        Ok(())
    }

    /// Reports spool depth and the age of the oldest entry.
    pub fn stats(&self) -> Result<SpoolStats, SpoolError> {
        let mut depth = 0usize;
        let mut oldest: Option<std::time::SystemTime> = None;
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("meta") {
                continue;
            }
            depth += 1;
            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    oldest = Some(match oldest {
                        Some(current) => current.min(modified),
                        None => modified,
                    });
                }
            }
        }
        let oldest_age_seconds = oldest.and_then(|time| {
            std::time::SystemTime::now()
                .duration_since(time)
                .ok()
                .map(|age| age.as_secs() as i64)
        });
        Ok(SpoolStats {
            depth,
            oldest_age_seconds,
        })
    }

    fn message_path(&self, id: MessageId) -> PathBuf {
        self.dir.join(format!("{id}.eml"))
    }

    fn meta_path(&self, id: MessageId) -> PathBuf {
        self.dir.join(format!("{id}.meta"))
    }
}

fn write_atomic(dir: &Path, path: &Path, contents: &[u8]) -> Result<(), SpoolError> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("spool");
    let temp = dir.join(format!(".{file_name}.tmp"));
    {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temp)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    std::fs::rename(&temp, path)?;
    sync_dir(dir)?;
    Ok(())
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::{Spool, SpoolError, SpoolMeta};
    use crate::message::{MessageId, Route};
    use crate::timestamp::Timestamp;

    fn meta(id: MessageId) -> SpoolMeta {
        SpoolMeta {
            message_id: id,
            sender: "sender@example.com".to_string(),
            dovecot_recipient: "user@example.com".to_string(),
            alias_ids: Vec::new(),
            primary_received: true,
            route: Route::Inbox,
            subject: "hello".to_string(),
            received_at: "2026-01-01T00:00:00Z".parse::<Timestamp>().unwrap(),
            attempts: 0,
        }
    }

    #[test]
    fn enqueue_then_list_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let spool = Spool::open(dir.path(), 16).unwrap();
        let id = MessageId::new();
        spool.enqueue(b"raw message", &meta(id)).unwrap();

        let entries = spool.entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].meta.subject, "hello");
        assert_eq!(spool.load_message(id).unwrap(), b"raw message");

        spool.remove(id).unwrap();
        assert!(spool.entries().unwrap().is_empty());
    }

    #[test]
    fn rejects_when_full() {
        let dir = tempfile::tempdir().unwrap();
        let spool = Spool::open(dir.path(), 1).unwrap();
        spool.enqueue(b"one", &meta(MessageId::new())).unwrap();
        let result = spool.enqueue(b"two", &meta(MessageId::new()));
        assert!(matches!(result, Err(SpoolError::Full { .. })));
    }

    #[test]
    fn stats_report_depth_and_age() {
        let dir = tempfile::tempdir().unwrap();
        let spool = Spool::open(dir.path(), 16).unwrap();
        let empty = spool.stats().unwrap();
        assert_eq!(empty.depth, 0);
        assert_eq!(empty.oldest_age_seconds, None);

        spool.enqueue(b"one", &meta(MessageId::new())).unwrap();
        let stats = spool.stats().unwrap();
        assert_eq!(stats.depth, 1);
        assert!(stats.oldest_age_seconds.unwrap() >= 0);
    }

    #[test]
    fn update_meta_increments_attempts() {
        let dir = tempfile::tempdir().unwrap();
        let spool = Spool::open(dir.path(), 16).unwrap();
        let id = MessageId::new();
        let mut value = meta(id);
        spool.enqueue(b"one", &value).unwrap();
        value.attempts = 3;
        spool.update_meta(&value).unwrap();
        assert_eq!(spool.entries().unwrap()[0].meta.attempts, 3);
    }
}
