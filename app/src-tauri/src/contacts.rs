//! Recipients ("rumuz") for the Wallet page (task W10b).
//!
//! A contact is a non-secret pair of a nickname and a `G...` address, persisted
//! as JSON under the app-support directory so the voice lane can resolve "send 5
//! XLM to ali" on a later turn. Nothing here is a secret and nothing here signs:
//! the store is a validated address book, and its only exit to the chain is the
//! `aliases` merge in [`crate::stellar_config`] (contacts < env `POLARIS_ALIASES`)
//! plus the committed `aliases.json` merged on the TypeScript side.
//!
//! Rules that matter:
//!
//! * **Fail-closed.** A nickname must match the alias charset and a non-reserved
//!   word; an address must be a checksum-valid public StrKey (reusing
//!   [`crate::bridge::strkey::decode_public_key`]). Anything malformed is
//!   refused with a typed error, never written.
//! * **No secrets.** The file holds public addresses only; the recovery phrase
//!   and secret keys live in the wallet engine's Keychain, never here.
//! * **Atomic + bounded.** A write goes to a sibling temp file and is renamed
//!   over the target, so a crash cannot leave a half-written book; the store is
//!   capped at [`MAX_CONTACTS`] entries.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::bridge::strkey::decode_public_key;

/// Broadcast when the book changes; the agent invalidates its alias memo on it.
pub const CONTACTS_EVENT_NAME: &str = "contacts_changed";

/// The file name under the app data directory.
pub const CONTACTS_FILE: &str = "contacts.json";

/// Upper bound on the book; a voice-resolved alias table should stay small.
pub const MAX_CONTACTS: usize = 200;

/// Words a nickname may not be: the agent's own verbs plus the object-prototype
/// keys the alias resolver already guards against. Kept deliberately short and
/// mirrored by `app/src/lib/contactsModel.ts`.
pub const RESERVED_NICKNAMES: &[&str] = &[
    "__proto__",
    "constructor",
    "prototype",
    "send",
    "payment",
    "pay",
    "swap",
    "deposit",
    "withdraw",
    "schedule",
    "cancel",
    "balance",
    "history",
    "wallet",
    "contacts",
];

/// One recipient. Field names are byte-identical to the TS mirror.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub nickname: String,
    pub address: String,
}

/// A typed rejection. Mirrors the wallet contract's error shape (`camelCase`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactsError {
    pub kind: ContactsErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContactsErrorKind {
    Invalid,
    Exists,
    NotFound,
    Limit,
    Io,
}

impl ContactsError {
    fn new(kind: ContactsErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

/// `trim` + ASCII lowercase; the UI lowercases too, but the store is the last
/// gate so a hand-edited file or a future caller cannot bypass it.
pub fn normalize_nickname(input: &str) -> String {
    input.trim().to_ascii_lowercase()
}

/// Validates an already-normalized nickname. `is_alias_name` owns the charset so
/// contacts and `POLARIS_ALIASES` cannot drift.
pub fn validate_nickname(nickname: &str) -> Result<(), ContactsError> {
    if !crate::stellar_config::is_alias_name(nickname) {
        return Err(ContactsError::new(
            ContactsErrorKind::Invalid,
            "nickname must start with a letter and use only a-z, 0-9, _ or - (max 32)",
        ));
    }
    if RESERVED_NICKNAMES.contains(&nickname) {
        return Err(ContactsError::new(
            ContactsErrorKind::Invalid,
            format!("nickname {nickname:?} is a reserved word"),
        ));
    }
    Ok(())
}

/// Validates a public `G...` address by checksum, not by shape.
pub fn validate_address(address: &str) -> Result<(), ContactsError> {
    if decode_public_key(address).is_none() {
        return Err(ContactsError::new(
            ContactsErrorKind::Invalid,
            "address is not a valid Stellar G... public key",
        ));
    }
    Ok(())
}

/// Reads the book from `path`; a missing file is an empty book, and a malformed
/// file is emptied rather than failing the command (fail-closed: no bad alias).
pub fn load_from(path: &Path) -> Vec<Contact> {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<Contact>>(&contents) {
        Ok(contacts) => contacts,
        Err(error) => {
            eprintln!("polaris: ignoring malformed {}: {error}", path.display());
            Vec::new()
        }
    }
}

/// Persists the book atomically: a sibling temp file is renamed over `path`, so
/// a reader never sees a partial file.
pub fn save_to(path: &Path, contacts: &[Contact]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(contacts)
        .map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

/// Validates and inserts `nickname`/`address`. `contacts` is left untouched on
/// any rejection, so a failed add is a no-op.
pub fn add_contact(
    contacts: &mut Vec<Contact>,
    nickname: &str,
    address: &str,
) -> Result<Contact, ContactsError> {
    let nickname = normalize_nickname(nickname);
    validate_nickname(&nickname)?;
    let address = address.trim();
    validate_address(address)?;
    if contacts.iter().any(|contact| contact.nickname == nickname) {
        return Err(ContactsError::new(
            ContactsErrorKind::Exists,
            format!("{nickname:?} is already saved"),
        ));
    }
    if contacts.len() >= MAX_CONTACTS {
        return Err(ContactsError::new(
            ContactsErrorKind::Limit,
            format!("the book is full ({MAX_CONTACTS} recipients)"),
        ));
    }
    let contact = Contact { nickname, address: address.to_string() };
    contacts.push(contact.clone());
    contacts.sort_by(|left, right| left.nickname.cmp(&right.nickname));
    Ok(contact)
}

/// Removes `nickname`, returning the removed contact or `notFound`.
pub fn remove_contact(contacts: &mut Vec<Contact>, nickname: &str) -> Result<Contact, ContactsError> {
    let nickname = normalize_nickname(nickname);
    let Some(index) = contacts.iter().position(|contact| contact.nickname == nickname) else {
        return Err(ContactsError::new(
            ContactsErrorKind::NotFound,
            format!("no recipient named {nickname:?}"),
        ));
    };
    Ok(contacts.remove(index))
}

/// `~/Library/Application Support/Polaris/contacts.json` (or the platform's app
/// data dir). `None` only when the OS cannot resolve one.
pub fn path_for(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(CONTACTS_FILE))
}

/// Loads the book for the running app; a missing/undecodable store is empty.
pub fn load_for_app(app: &AppHandle) -> Vec<Contact> {
    path_for(app).map(|path| load_from(&path)).unwrap_or_default()
}

/// Persists the book for the running app and broadcasts the new list.
fn save_for_app(app: &AppHandle, contacts: &[Contact]) -> Result<(), ContactsError> {
    let Some(path) = path_for(app) else {
        return Err(ContactsError::new(ContactsErrorKind::Io, "no writable app data directory"));
    };
    save_to(&path, contacts)
        .map_err(|error| ContactsError::new(ContactsErrorKind::Io, error.to_string()))?;
    // Best-effort: a lost refresh must not fail an otherwise committed write.
    if let Err(error) = app.emit(CONTACTS_EVENT_NAME, contacts) {
        eprintln!("polaris: failed to emit {CONTACTS_EVENT_NAME}: {error}");
    }
    Ok(())
}

/// The recipients saved on this machine, sorted by nickname.
#[tauri::command]
pub fn contacts_list(app: AppHandle) -> Vec<Contact> {
    load_for_app(&app)
}

/// Adds a recipient. Rejects an invalid address/nickname, a duplicate nickname
/// and a full book.
#[tauri::command]
pub fn contacts_add(
    app: AppHandle,
    nickname: String,
    address: String,
) -> Result<Contact, ContactsError> {
    let mut contacts = load_for_app(&app);
    let contact = add_contact(&mut contacts, &nickname, &address)?;
    save_for_app(&app, &contacts)?;
    Ok(contact)
}

/// Removes a recipient by nickname.
#[tauri::command]
pub fn contacts_remove(app: AppHandle, nickname: String) -> Result<Contact, ContactsError> {
    let mut contacts = load_for_app(&app);
    let removed = remove_contact(&mut contacts, &nickname)?;
    save_for_app(&app, &contacts)?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALI: &str = "GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25A";
    const BOB: &str = "GB25QEDATQREAQQHBW3DAGLOZ3EURS44URZETXLLREPPYCX2ABCORNLV";

    #[test]
    fn normalizes_and_validates_nicknames() {
        assert_eq!(normalize_nickname("  ALI  "), "ali");
        assert!(validate_nickname("ali").is_ok());
        assert!(validate_nickname("my-alias_1").is_ok());
        assert!(validate_nickname("1ali").is_err());
        assert!(validate_nickname("Ali").is_err());
        assert!(validate_nickname("").is_err());
        assert!(validate_nickname("send").is_err());
        assert!(validate_nickname("__proto__").is_err());
    }

    #[test]
    fn validates_addresses_by_checksum() {
        assert!(validate_address(ALI).is_ok());
        // Last base32 char mutated: shape-valid, checksum-invalid.
        let mutated = "GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25B";
        assert!(validate_address(mutated).is_err());
        assert!(validate_address("not-an-address").is_err());
    }

    #[test]
    fn add_contact_normalizes_sorts_and_dedupes() {
        let mut contacts = Vec::new();
        add_contact(&mut contacts, "Bob", BOB).unwrap();
        add_contact(&mut contacts, "  ALI ", ALI).unwrap();
        assert_eq!(
            contacts.iter().map(|c| c.nickname.as_str()).collect::<Vec<_>>(),
            ["ali", "bob"]
        );
        assert_eq!(contacts[0].address, ALI);

        let duplicate = add_contact(&mut contacts, "ali", BOB).unwrap_err();
        assert_eq!(duplicate.kind, ContactsErrorKind::Exists);
        // A rejected add must not mutate.
        assert_eq!(contacts.len(), 2);

        assert_eq!(
            add_contact(&mut contacts, "bad name", ALI).unwrap_err().kind,
            ContactsErrorKind::Invalid
        );
        assert_eq!(
            add_contact(&mut contacts, "carol", "Gbad").unwrap_err().kind,
            ContactsErrorKind::Invalid
        );
    }

    #[test]
    fn remove_contact_reports_not_found_and_normalizes() {
        let mut contacts = vec![Contact { nickname: "ali".into(), address: ALI.into() }];
        assert_eq!(remove_contact(&mut contacts, "ALI").unwrap().nickname, "ali");
        assert!(contacts.is_empty());
        assert_eq!(
            remove_contact(&mut contacts, "ali").unwrap_err().kind,
            ContactsErrorKind::NotFound
        );
    }

    #[test]
    fn round_trips_through_an_atomic_file() {
        let dir = crate::env::temp_dir("contacts-roundtrip");
        let path = dir.join(CONTACTS_FILE);
        assert!(load_from(&path).is_empty(), "a missing file is an empty book");

        let contacts = vec![Contact { nickname: "ali".into(), address: ALI.into() }];
        save_to(&path, &contacts).unwrap();
        assert_eq!(load_from(&path), contacts);
        // The temp file never lingers after a successful rename.
        assert!(!path.with_extension("json.tmp").exists());

        std::fs::write(&path, "{ not json").unwrap();
        assert!(load_from(&path).is_empty(), "malformed JSON fails closed");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn enforces_the_book_limit() {
        let mut contacts: Vec<Contact> = (0..MAX_CONTACTS)
            .map(|index| Contact { nickname: format!("a{index}"), address: ALI.into() })
            .collect();
        assert_eq!(
            add_contact(&mut contacts, "overflow", BOB).unwrap_err().kind,
            ContactsErrorKind::Limit
        );
    }
}
