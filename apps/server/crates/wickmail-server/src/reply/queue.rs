//! Outbound submission queue.
//!
//! A reply is queued for submission only after it passes identity and lease
//! checks. The queue is the point of acceptance: the alias renews once the
//! message is enqueued, and a later bounce does not remove it from the queue's
//! history or revert the renewal. The queue is an interface so the reply path
//! is independent of the storage backend.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::alias::AliasId;
use crate::message::MessageId;
use crate::timestamp::Timestamp;

/// Metadata for one queued outbound message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundMeta {
    /// Queue identity, also the message identity.
    pub id: MessageId,
    /// The alias the message was sent as, or `None` for the primary identity.
    pub alias_id: Option<AliasId>,
    /// The SMTP envelope sender.
    pub envelope_sender: String,
    /// The SMTP envelope recipients.
    pub envelope_recipients: Vec<String>,
    /// When the message was accepted.
    pub queued_at: Timestamp,
    /// Delivery attempts made so far.
    #[serde(default)]
    pub attempts: u32,
}

/// A queued outbound message and its signed bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboundMessage {
    /// Queue metadata.
    pub meta: OutboundMeta,
    /// The signed raw message.
    pub raw: Vec<u8>,
}

impl OutboundMessage {
    /// The queue identity.
    pub fn id(&self) -> MessageId {
        self.meta.id
    }
}

/// Why an outbound queue operation failed.
#[derive(Debug, Error)]
pub enum QueueError {
    /// The underlying filesystem call failed.
    #[error(transparent)]
    Io(#[from] io::Error),
    /// Stored metadata could not be decoded.
    #[error("corrupt outbound metadata: {0}")]
    Corrupt(String),
}

/// The outbound submission queue.
pub trait OutboundQueue: Send + Sync {
    /// Accepts a message for delivery.
    fn enqueue(&self, message: &OutboundMessage) -> Result<(), QueueError>;
    /// Every queued message's metadata, oldest first.
    fn list(&self) -> Result<Vec<OutboundMeta>, QueueError>;
    /// One queued message, or `None`.
    fn get(&self, id: MessageId) -> Result<Option<OutboundMessage>, QueueError>;
    /// Removes a message after successful delivery.
    fn remove(&self, id: MessageId) -> Result<(), QueueError>;
}

/// A directory-backed outbound queue.
///
/// Each message is stored as `<id>.eml` and `<id>.json`, both written
/// atomically before `enqueue` returns.
pub struct FileOutboundQueue {
    dir: PathBuf,
}

impl FileOutboundQueue {
    /// Opens or creates a queue directory.
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, QueueError> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    /// The queue directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn raw_path(&self, id: MessageId) -> PathBuf {
        self.dir.join(format!("{id}.eml"))
    }

    fn meta_path(&self, id: MessageId) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }
}

impl OutboundQueue for FileOutboundQueue {
    fn enqueue(&self, message: &OutboundMessage) -> Result<(), QueueError> {
        let meta_json = serde_json::to_vec(&message.meta)
            .map_err(|error| QueueError::Corrupt(error.to_string()))?;
        let raw_path = self.raw_path(message.id());
        let meta_path = self.meta_path(message.id());
        write_atomic(&self.dir, &raw_path, &message.raw)?;
        if let Err(error) = write_atomic(&self.dir, &meta_path, &meta_json) {
            let _ = std::fs::remove_file(&raw_path);
            return Err(error);
        }
        Ok(())
    }

    fn list(&self) -> Result<Vec<OutboundMeta>, QueueError> {
        let mut metas = Vec::new();
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let bytes = std::fs::read(&path)?;
            let meta: OutboundMeta = serde_json::from_slice(&bytes)
                .map_err(|error| QueueError::Corrupt(error.to_string()))?;
            metas.push(meta);
        }
        metas.sort_by_key(|meta| (meta.queued_at, meta.id));
        Ok(metas)
    }

    fn get(&self, id: MessageId) -> Result<Option<OutboundMessage>, QueueError> {
        let meta_path = self.meta_path(id);
        let meta_bytes = match std::fs::read(&meta_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let meta: OutboundMeta = serde_json::from_slice(&meta_bytes)
            .map_err(|error| QueueError::Corrupt(error.to_string()))?;
        let raw = std::fs::read(self.raw_path(id))?;
        Ok(Some(OutboundMessage { meta, raw }))
    }

    fn remove(&self, id: MessageId) -> Result<(), QueueError> {
        remove_if_present(&self.raw_path(id))?;
        remove_if_present(&self.meta_path(id))?;
        sync_dir(&self.dir)?;
        Ok(())
    }
}

/// An in-memory outbound queue for tests and the walking skeleton.
#[derive(Default)]
pub struct MemoryOutboundQueue {
    messages: Mutex<HashMap<MessageId, OutboundMessage>>,
}

impl MemoryOutboundQueue {
    /// Creates an empty queue.
    pub fn new() -> Self {
        Self::default()
    }
}

impl OutboundQueue for MemoryOutboundQueue {
    fn enqueue(&self, message: &OutboundMessage) -> Result<(), QueueError> {
        let mut messages = self.messages.lock().expect("queue lock poisoned");
        messages
            .entry(message.id())
            .or_insert_with(|| message.clone());
        Ok(())
    }

    fn list(&self) -> Result<Vec<OutboundMeta>, QueueError> {
        let messages = self.messages.lock().expect("queue lock poisoned");
        let mut metas: Vec<OutboundMeta> = messages
            .values()
            .map(|message| message.meta.clone())
            .collect();
        metas.sort_by_key(|meta| (meta.queued_at, meta.id));
        Ok(metas)
    }

    fn get(&self, id: MessageId) -> Result<Option<OutboundMessage>, QueueError> {
        let messages = self.messages.lock().expect("queue lock poisoned");
        Ok(messages.get(&id).cloned())
    }

    fn remove(&self, id: MessageId) -> Result<(), QueueError> {
        let mut messages = self.messages.lock().expect("queue lock poisoned");
        messages.remove(&id);
        Ok(())
    }
}

fn write_atomic(dir: &Path, path: &Path, contents: &[u8]) -> Result<(), QueueError> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("outbound");
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
    use super::{
        FileOutboundQueue, MemoryOutboundQueue, OutboundMessage, OutboundMeta, OutboundQueue,
    };
    use crate::message::MessageId;
    use crate::timestamp::Timestamp;

    fn message(subject: &str) -> OutboundMessage {
        OutboundMessage {
            meta: OutboundMeta {
                id: MessageId::new(),
                alias_id: None,
                envelope_sender: "green.farm@example.com".to_string(),
                envelope_recipients: vec!["sender@example.net".to_string()],
                queued_at: "2026-01-04T00:00:00Z".parse::<Timestamp>().unwrap(),
                attempts: 0,
            },
            raw: subject.as_bytes().to_vec(),
        }
    }

    #[test]
    fn file_queue_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let queue = FileOutboundQueue::open(dir.path()).unwrap();
        let message = message("Subject: hi\r\n\r\nbody");
        queue.enqueue(&message).unwrap();

        assert_eq!(queue.list().unwrap().len(), 1);
        let loaded = queue.get(message.id()).unwrap().unwrap();
        assert_eq!(loaded.raw, message.raw);
        assert_eq!(loaded.meta.envelope_sender, "green.farm@example.com");

        queue.remove(message.id()).unwrap();
        assert!(queue.list().unwrap().is_empty());
        assert!(queue.get(message.id()).unwrap().is_none());
    }

    #[test]
    fn memory_queue_is_idempotent_on_identity() {
        let queue = MemoryOutboundQueue::new();
        let message = message("one");
        queue.enqueue(&message).unwrap();
        queue.enqueue(&message).unwrap();
        assert_eq!(queue.list().unwrap().len(), 1);
    }
}
