//! Readable random alias generation.
//!
//! Local parts are lowercase dictionary words, two separated by a dot by
//! default, selected with a cryptographically secure random number generator.
//! Generation carries no policy, and callers enforce uniqueness with a retry
//! that adds a word when the two-word attempt budget is spent.

use thiserror::Error;

use crate::address::{AddressError, CanonicalAddress, Domain};
use crate::wordlist::WORDS;

/// Default number of words in a generated local part.
pub const DEFAULT_WORDS: usize = 2;

/// Two-word attempts before falling back to a third word.
pub const MAX_TWO_WORD_ATTEMPTS: usize = 8;

/// Total attempts before generation gives up.
pub const MAX_ATTEMPTS: usize = 64;

/// Why alias generation failed.
#[derive(Debug, Error)]
pub enum GenerateError {
    /// The operating system random source was unavailable.
    #[error("random source unavailable: {0}")]
    Entropy(String),
    /// The generated local part or domain was invalid.
    #[error(transparent)]
    Address(#[from] AddressError),
    /// No unique address was found within the attempt budget.
    #[error("no unique alias found after {attempts} attempts")]
    Exhausted {
        /// Attempts made before giving up.
        attempts: usize,
    },
}

/// Generates readable random alias local parts.
#[derive(Clone, Debug)]
pub struct AliasGenerator {
    words: Vec<&'static str>,
    max_two_word_attempts: usize,
    max_attempts: usize,
}

impl Default for AliasGenerator {
    fn default() -> Self {
        Self::new()
    }
}

impl AliasGenerator {
    /// Creates a generator over the curated word list.
    pub fn new() -> Self {
        Self::from_words(WORDS.to_vec())
    }

    /// Creates a generator over a caller-supplied word list, for tests.
    pub fn from_words(words: Vec<&'static str>) -> Self {
        Self {
            words,
            max_two_word_attempts: MAX_TWO_WORD_ATTEMPTS,
            max_attempts: MAX_ATTEMPTS,
        }
    }

    /// Generates a two-word local part.
    pub fn generate_local_part(&self) -> Result<String, GenerateError> {
        self.random_local_part(DEFAULT_WORDS)
    }

    /// Generates a unique canonical address for `domain`.
    ///
    /// `is_taken` reports whether a candidate address already exists. The
    /// generator retries with a new combination and adds a word once the
    /// two-word attempt budget is spent.
    pub fn generate<F>(
        &self,
        domain: &Domain,
        mut is_taken: F,
    ) -> Result<CanonicalAddress, GenerateError>
    where
        F: FnMut(&CanonicalAddress) -> bool,
    {
        if self.words.is_empty() {
            return Err(GenerateError::Exhausted { attempts: 0 });
        }
        for attempt in 0..self.max_attempts {
            let word_count = if attempt < self.max_two_word_attempts {
                DEFAULT_WORDS
            } else {
                DEFAULT_WORDS + 1
            };
            let local_part = self.random_local_part(word_count)?;
            let address = CanonicalAddress::from_parts(&local_part, domain)?;
            if !is_taken(&address) {
                return Ok(address);
            }
        }
        Err(GenerateError::Exhausted {
            attempts: self.max_attempts,
        })
    }

    fn random_local_part(&self, word_count: usize) -> Result<String, GenerateError> {
        let mut words = Vec::with_capacity(word_count);
        for _ in 0..word_count {
            words.push(self.random_word()?);
        }
        Ok(words.join("."))
    }

    fn random_word(&self) -> Result<&'static str, GenerateError> {
        let count = self.words.len() as u64;
        let index =
            unbiased_index(count).map_err(|error| GenerateError::Entropy(error.to_string()))?;
        Ok(self.words[index as usize])
    }
}

/// Draws a uniformly distributed index in `[0, count)`.
///
/// Rejection sampling keeps the distribution unbiased even though the random
/// source is not an exact multiple of `count`.
fn unbiased_index(count: u64) -> Result<u64, getrandom::Error> {
    if count <= 1 {
        return Ok(0);
    }
    let limit = u64::MAX - (u64::MAX % count);
    loop {
        let value = getrandom::u64()?;
        if value < limit {
            return Ok(value % count);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AliasGenerator, GenerateError};
    use crate::address::Domain;
    use crate::wordlist::WORDS;
    use std::collections::HashSet;

    fn domain() -> Domain {
        Domain::parse("example.com").unwrap()
    }

    #[test]
    fn default_local_part_is_two_dictionary_words() {
        let generator = AliasGenerator::new();
        for _ in 0..64 {
            let local_part = generator.generate_local_part().unwrap();
            let words: Vec<_> = local_part.split('.').collect();
            assert_eq!(words.len(), 2, "unexpected local part {local_part:?}");
            for word in words {
                assert!(WORDS.contains(&word), "unknown word {word:?}");
            }
            assert!(
                local_part
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character == '.'),
                "local part contains policy or unexpected characters: {local_part:?}"
            );
        }
    }

    #[test]
    fn generated_addresses_are_canonical_and_unique_in_practice() {
        let generator = AliasGenerator::new();
        let mut seen = HashSet::new();
        for _ in 0..128 {
            let address = generator
                .generate(&domain(), |candidate| seen.contains(candidate))
                .unwrap();
            assert_eq!(address.domain(), "example.com");
            assert!(seen.insert(address), "generator returned a duplicate");
        }
    }

    #[test]
    fn retries_on_collision_then_succeeds() {
        let generator = AliasGenerator::new();
        let mut attempts = 0;
        let address = generator
            .generate(&domain(), |_| {
                attempts += 1;
                attempts <= 3
            })
            .unwrap();
        assert_eq!(attempts, 4);
        assert_eq!(address.local_part().split('.').count(), 2);
    }

    #[test]
    fn adds_a_third_word_when_two_word_space_is_exhausted() {
        let generator = AliasGenerator::from_words(vec!["a", "b"]);
        let two_word: HashSet<String> = ["a.a", "a.b", "b.a", "b.b"]
            .iter()
            .map(|local| format!("{local}@example.com"))
            .collect();
        let address = generator
            .generate(&domain(), |candidate| two_word.contains(candidate.as_str()))
            .unwrap();
        assert_eq!(address.local_part().split('.').count(), 3);
    }

    #[test]
    fn exhausts_when_nothing_is_available() {
        let generator = AliasGenerator::from_words(vec!["a", "b"]);
        let result = generator.generate(&domain(), |_| true);
        assert!(matches!(result, Err(GenerateError::Exhausted { .. })));
    }

    #[test]
    fn empty_word_list_exhausts_immediately() {
        let generator = AliasGenerator::from_words(Vec::new());
        assert!(matches!(
            generator.generate(&domain(), |_| false),
            Err(GenerateError::Exhausted { attempts: 0 })
        ));
    }
}
