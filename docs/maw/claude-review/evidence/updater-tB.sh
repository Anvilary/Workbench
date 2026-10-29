. "$(dirname "$0")/updater-fixture-lib.sh"; mkfixture
push_commit two; git -C $F/src reset -q --hard HEAD~1
echo "== B1: SIGTERM delivered to updater during build"
PNPM_SLEEP=3 sh $UPD --no-restart --ref origin/main > $F/b1.out 2>&1 &
U=$!; sleep 1.2; echo "lock before TERM: $(cat $F/state/update.lock) (updater pid $U)"; kill -TERM $U
sleep 0.3; echo "lock after TERM, while updater still alive? alive=$(kill -0 $U 2>/dev/null && echo yes || echo no) lockfile=$(cat $F/state/update.lock 2>/dev/null || echo MISSING)"
wait $U; echo "updater exit=$?"; show; tail -3 $F/b1.out | sed "s#$F#\$F#g"
echo; echo "== B2: SIGKILL (or SIGHUP from closed terminal tab) during build"
F2=$F; mkfixture; push_commit two; git -C $F/src reset -q --hard HEAD~1
PNPM_SLEEP=3 sh $UPD --no-restart --ref origin/main > $F/b2.out 2>&1 &
U=$!; sleep 1.2; kill -HUP $U; sleep 3.5
echo "stale lock: $(cat $F/state/update.lock 2>/dev/null || echo none)"; echo "releases dir: $(ls $F/state/releases)"; git -C $F/src worktree list | sed "s#$F#\$F#g"; show
echo "-- re-run updater after interruption:"; sh $UPD --no-restart --ref origin/main 2>&1 | tail -2 | sed "s#$F#\$F#g"; show; echo "releases: $(ls $F/state/releases | tr '\n' ' ')"; git -C $F/src worktree list | sed "s#$F#\$F#g"
