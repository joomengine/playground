# Deployment workspaces

This change extends portable deployments with schema-driven forms, authenticated package downloads, component configuration and capture, and verified JCB upgrades in independent saved-site copies.

## Implementation order

1. Implement friendly schema-driven forms with localized labels, help, validation, and an advanced JSON editor that preserves values.
2. Preserve authenticated GitHub, Gitea, GitLab and direct package sources across editing, export, import and installation.
3. Apply component records and options, module instances and plugin settings through authenticated Joomla/JCB native models after installation; report individual failures without stopping unrelated configuration.
4. Capture supported saved administrator data into editable deployment entries, retaining portable identities and relationships.
5. Clone saved sites before upgrading JCB through the normal installer, reject downgrades and verify the installed version.
6. Complete integration, then run existing checks and focused behavioral tests; fix failures before marking the PR ready.

FTP/SFTP and Server integration are outside this change. Existing deployment documents remain readable. Public sharing remains separate from private exports containing credentials. No production merge or deployment is part of this implementation task.
