#!/bin/sh
# Shows that maw.service's own limits (Restart=on-failure, RestartSec=5,
# StartLimitBurst=3/120s) put a crash-on-start release into start-limit-hit
# within ~15 s, after which the rollback's manual `systemctl --user restart` is
# refused. Uses a disposable transient unit; never touches maw.service.
U=maw-audit-startlimit-$$
systemd-run --user --unit=$U -p Type=exec -p Restart=on-failure -p RestartSec=5 \
  -p StartLimitIntervalSec=120 -p StartLimitBurst=3 /bin/sh -c 'sleep 1; exit 1'
sleep 26
systemctl --user show $U -p ActiveState,Result,NRestarts
systemctl --user restart $U; echo "manual restart exit=$?"
journalctl --user -u $U --no-pager -o cat | grep -c 'Start request repeated too quickly'
systemctl --user reset-failed $U 2>/dev/null; systemctl --user stop $U 2>/dev/null
