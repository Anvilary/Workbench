# MAW operations

Installation is unchanged at checkpoint zero. No managed service has been activated.
User lingering was already enabled at inventory. A user service enabled under default.target starts at login; with lingering it can start at boot before login and continue after logout, using this user's permissions and resources. No root service is needed.

Activation remains pending isolated lifecycle checks. The service must use the original repository path, verified absolute Node path, loopback binding and existing authenticated URL security. Server-owned PTYs end on server shutdown; native conversation recovery starts replacement processes and cannot preserve process-local scrollback.

Rollback: leave main and existing user configuration untouched; do not remove native history or credentials. A future installed service can be disabled with systemctl --user disable --now maw.service, after warning about live PTYs. This does not disable lingering or unrelated units.
