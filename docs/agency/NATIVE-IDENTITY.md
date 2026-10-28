# Native identity and resume ownership

Policy adopted for the pre-QA remediation, before implementation:

An Agency profile names an executable configuration; it is not an account principal.
Structured Codex discovery and history require a verified provider and canonical
native home captured at launch. The server's CODEX_HOME is never evidence for a
named profile. An opaque wrapper remains usable in the interactive PTY, but its
structured Codex history and identity-dependent resume are unavailable.

Native resume requires the requested ID to exist in the verified home. If Agency
previously recorded that ID, every historical owner must have the same verified
provider/home identity. Legacy rows with unknown identity fail closed. Profiles
with the same verified provider/home may transfer an inactive conversation;
different homes may not. Active-controller exclusion remains in force, including
across named profiles. Restart does not confer identity on legacy metadata.

The optional host-owned `agency-native-identities.json` in the application config
directory supplies explicit attestations. It is read once at startup and has no
socket mutation endpoint. Version 1 contains `identities`, each with `profileId`,
`provider` (currently `codex`), exact configured `executable`, exact `args`, exact
`environmentOverrides`, and canonical absolute `home`. The host must verify the
wrapper's effective home independently before creating this record. A path or a
literal export in wrapper text is not verification. This record trusts host code,
just as configuring an executable does; it does not constrain a dishonest wrapper.
Any executable/argv/environment mismatch invalidates the binding. Relative,
missing, or noncanonical homes are rejected. No credential file is read or changed.

Absent records are normal and leave native interaction available. Verified homes
join protected paths, including for sockets already connected and immediately
before process creation. A launch keeps its immutable identity if configuration
later changes. Workbench's existing native CLI paths retain their original behavior.
This change makes no claim to infer account changes within the same native home.
