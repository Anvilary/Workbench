. "$(dirname "$0")/updater-fixture-lib.sh"; mkfixture
mkdir -p $F/state/releases/good $F/state/releases/bad; ln -sfn $F/state/releases/good $F/state/previous; ln -sfn $F/state/releases/bad $F/state/current
echo 'process.exit(1)' > $F/bin/control-unhealthy.mjs
cat > $F/bin/systemctl <<'S'
#!/bin/sh
n=$(cat "$FIXLOG.restarts" 2>/dev/null || echo 0)
case " $* " in *" restart "*) n=$((n+1)); echo $n > "$FIXLOG.restarts"; echo "systemctl restart #$n" >> "$FIXLOG"
  if [ "$n" -ge "${FAIL_FROM:-99}" ]; then echo "Job for maw.service failed because the service was attempted to start too often." >&2; exit 1; fi;; esac
exit 0
S
chmod +x $F/bin/systemctl
echo "== D1: new release fails at 'systemctl restart' itself (e.g. ExecStartPre / start-limit-hit)"
FAIL_FROM=1 MAW_CONTROL_SCRIPT=$F/bin/control-unhealthy.mjs sh $HELPER --unit maw-fixture.service --timeout 2 2>&1 | sed "s#$F#\$F#g"; echo "exit=$?"; show
rm -f $FIXLOG.restarts; ln -sfn $F/state/releases/bad $F/state/current
echo; echo "== D2: new release crash-loops, rollback restart is refused (start-limit-hit)"
FAIL_FROM=2 MAW_CONTROL_SCRIPT=$F/bin/control-unhealthy.mjs sh $HELPER --unit maw-fixture.service --timeout 2 2>&1 | sed "s#$F#\$F#g"; show
