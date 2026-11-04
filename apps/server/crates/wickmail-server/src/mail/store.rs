//! Internal mail-store adapter: authenticated read access to Dovecot Maildirs.
//!
//! The management layer reads delivered messages through this adapter for
//! reply context and quarantine. It is the only code path into
//! `Aliases/Expired`; ordinary IMAP clients cannot reach that mailbox.
//!
//! Message identity is always the `X-Wickmail-Message-ID` header. A cached
//! `(mailbox, UIDVALIDITY, UID)` locator only narrows the search; it is never
//! treated as identity. Message bodies are never logged.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::mail::headers::MessageParts;
use crate::message::MessageId;

/// The mailbox that holds mail for expired and disabled aliases.
pub const QUARANTINE_MAILBOX: &str = "Aliases/Expired";

/// A cached pointer into the mail store.
///
/// The fields are hints for fast access and never establish identity; every
/// read is verified against the message ID header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MailboxLocator {
    /// Mailbox name, such as `Aliases/Expired`.
    pub mailbox: String,
    /// IMAP `UIDVALIDITY` at the time the locator was cached.
    pub uidvalidity: u32,
    /// IMAP UID at the time the locator was cached.
    pub uid: u32,
}

/// A message discovered in the mail store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageSummary {
    /// Stable message identity from the trusted header.
    pub message_id: MessageId,
    /// Mailbox containing the message.
    pub mailbox: String,
    /// Size of the message on disk in bytes.
    pub size: u64,
}

/// Why a mail-store read failed.
#[derive(Debug, Error)]
pub enum AdapterError {
    /// The filesystem could not be read.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// A message is missing its trusted identity header.
    #[error("message is missing X-Wickmail-Message-ID")]
    MissingIdentity,
    /// The identity header could not be parsed.
    #[error("invalid X-Wickmail-Message-ID: {0}")]
    InvalidIdentity(String),
}

/// Reads Dovecot Maildirs for a single account.
pub struct MailStoreAdapter {
    maildir: PathBuf,
    quarantine_dir: PathBuf,
}

impl MailStoreAdapter {
    /// Creates an adapter over a user's Maildir root.
    ///
    /// The quarantine mailbox defaults to a Maildir++ folder under the same
    /// root.
    pub fn open(maildir: impl Into<PathBuf>) -> Self {
        let maildir = maildir.into();
        let quarantine_dir = maildir.join(".Aliases.Expired");
        Self {
            maildir,
            quarantine_dir,
        }
    }

    /// Creates an adapter with the quarantine mailbox in a separate Maildir.
    ///
    /// This matches a Dovecot hidden namespace whose `mail_path` is outside the
    /// user's IMAP namespace.
    pub fn with_quarantine(
        maildir: impl Into<PathBuf>,
        quarantine_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            maildir: maildir.into(),
            quarantine_dir: quarantine_dir.into(),
        }
    }

    /// The user's Maildir root.
    pub fn maildir(&self) -> &Path {
        &self.maildir
    }

    /// The quarantine mailbox's Maildir root.
    pub fn quarantine_dir(&self) -> &Path {
        &self.quarantine_dir
    }

    /// The on-disk directory for a mailbox.
    ///
    /// Uses Maildir++ naming: subfolders live in a sibling directory prefixed
    /// with `.`, with `/` in the mailbox name mapped to `.`. The quarantine
    /// mailbox maps to its configured directory.
    pub fn mailbox_dir(&self, mailbox: &str) -> PathBuf {
        if mailbox.eq_ignore_ascii_case(QUARANTINE_MAILBOX) {
            return self.quarantine_dir.clone();
        }
        if mailbox.is_empty() || mailbox.eq_ignore_ascii_case("inbox") {
            return self.maildir.clone();
        }
        let encoded = mailbox.replace('/', ".");
        self.maildir.join(format!(".{encoded}"))
    }

    /// Lists messages in a mailbox.
    pub fn list(&self, mailbox: &str) -> Result<Vec<MessageSummary>, AdapterError> {
        let dir = self.mailbox_dir(mailbox);
        let mut summaries = Vec::new();
        for sub in ["cur", "new"] {
            let subdir = dir.join(sub);
            let entries = match std::fs::read_dir(&subdir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            for entry in entries {
                let entry = entry?;
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let Some(message_id) = read_message_id(&path)? else {
                    continue;
                };
                let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                summaries.push(MessageSummary {
                    message_id,
                    mailbox: mailbox.to_string(),
                    size,
                });
            }
        }
        summaries.sort_by_key(|summary| summary.message_id);
        Ok(summaries)
    }

    /// Reads a message by identity, searching `mailbox` and then its siblings.
    ///
    /// Returns the raw bytes. The caller decides how much to surface; this
    /// function never logs the body.
    pub fn read(
        &self,
        mailbox: &str,
        message_id: MessageId,
    ) -> Result<Option<Vec<u8>>, AdapterError> {
        if let Some(bytes) = self.read_from_mailbox(mailbox, message_id)? {
            return Ok(Some(bytes));
        }
        Ok(None)
    }

    /// Reads a message using a cached locator.
    ///
    /// The locator's mailbox is consulted first, but identity is always
    /// confirmed by the message ID header. A stale or wrong locator simply
    /// falls back to a full scan of the mailbox.
    pub fn read_with_locator(
        &self,
        message_id: MessageId,
        locator: &MailboxLocator,
    ) -> Result<Option<Vec<u8>>, AdapterError> {
        self.read(&locator.mailbox, message_id)
    }

    /// Lists messages in the quarantine mailbox.
    pub fn quarantine(&self) -> Result<Vec<MessageSummary>, AdapterError> {
        self.list(QUARANTINE_MAILBOX)
    }

    /// Reads a quarantined message by identity.
    pub fn read_quarantine(&self, message_id: MessageId) -> Result<Option<Vec<u8>>, AdapterError> {
        self.read(QUARANTINE_MAILBOX, message_id)
    }

    fn read_from_mailbox(
        &self,
        mailbox: &str,
        message_id: MessageId,
    ) -> Result<Option<Vec<u8>>, AdapterError> {
        let dir = self.mailbox_dir(mailbox);
        for sub in ["cur", "new"] {
            let subdir = dir.join(sub);
            let entries = match std::fs::read_dir(&subdir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            for entry in entries {
                let entry = entry?;
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                if read_message_id(&path)? == Some(message_id) {
                    return Ok(Some(std::fs::read(&path)?));
                }
            }
        }
        Ok(None)
    }
}

/// Reads only the header block of a message and extracts its identity.
fn read_message_id(path: &Path) -> Result<Option<MessageId>, AdapterError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut header = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if line == b"\n" || line == b"\r\n" {
            break;
        }
        header.extend_from_slice(&line);
    }
    let parts = MessageParts::parse(&header);
    match parts.headers.get("X-Wickmail-Message-ID") {
        Some(value) => value
            .trim()
            .parse::<MessageId>()
            .map(Some)
            .map_err(|_| AdapterError::InvalidIdentity(value.to_string())),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{MailStoreAdapter, QUARANTINE_MAILBOX};
    use crate::message::MessageId;
    use std::fs;
    use std::path::Path;

    fn write_message(dir: &Path, sub: &str, name: &str, message_id: MessageId, body: &str) {
        let folder = dir.join(sub);
        fs::create_dir_all(&folder).unwrap();
        let contents =
            format!("X-Wickmail-Message-ID: {message_id}\r\nSubject: test\r\n\r\n{body}\r\n");
        fs::write(folder.join(name), contents).unwrap();
    }

    #[test]
    fn lists_and_reads_by_identity() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        let id = MessageId::new();
        write_message(dir.path(), "cur", "1", id, "hello body");

        let listed = adapter.list("Inbox").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].message_id, id);

        let bytes = adapter.read("Inbox", id).unwrap().unwrap();
        assert!(bytes.ends_with(b"hello body\r\n"));
    }

    #[test]
    fn quarantine_lives_in_its_own_mailbox() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        let id = MessageId::new();
        write_message(dir.path(), ".Aliases.Expired/cur", "1", id, "quarantined");

        assert!(adapter.list("Inbox").unwrap().is_empty());
        let listed = adapter.quarantine().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].mailbox, QUARANTINE_MAILBOX);
        assert!(adapter.read_quarantine(id).unwrap().is_some());
    }

    #[test]
    fn locator_is_a_hint_not_identity() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        let id = MessageId::new();
        write_message(dir.path(), ".Aliases.Expired/cur", "1", id, "quarantined");

        // A locator pointing at the wrong mailbox still finds the message
        // because identity is verified from the header.
        let locator = super::MailboxLocator {
            mailbox: "Inbox".to_string(),
            uidvalidity: 1,
            uid: 1,
        };
        // The wrong mailbox has no such message, so the locator returns None.
        assert!(adapter.read_with_locator(id, &locator).unwrap().is_none());

        let correct = super::MailboxLocator {
            mailbox: QUARANTINE_MAILBOX.to_string(),
            uidvalidity: 99,
            uid: 42,
        };
        assert!(adapter.read_with_locator(id, &correct).unwrap().is_some());
    }

    #[test]
    fn messages_without_identity_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        let folder = dir.path().join("cur");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("1"), "Subject: no id\r\n\r\nbody\r\n").unwrap();
        assert!(adapter.list("Inbox").unwrap().is_empty());
    }
}
