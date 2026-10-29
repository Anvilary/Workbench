. "$(dirname "$0")/updater-fixture-lib.sh"; mkfixture
echo "== A: initial (install.sh layout)"; show
push_commit two; git -C $F/src reset -q --hard HEAD~1
sh $UPD --no-restart --ref origin/main >/dev/null 2>&1; echo "== after staging #1 (--no-restart), exit=$?"; show
echo "   running service would still be on: \$F/src (dev checkout)"
git -C $F/src merge -q --ff-only origin/main
push_commit three; git -C $F/src reset -q --hard HEAD~1
sh $UPD --no-restart --ref origin/main >/dev/null 2>&1; echo "== after staging #2 (--no-restart), exit=$?"; show
echo "== rollback target 'previous' has release meta?"; cat $F/state/previous/.maw-release-meta.json | sed "s#$F#\$F#g"
echo "== update-log:"; sed "s#$F#\$F#g" $F/state/update-log.jsonl
echo "== git worktree list:"; git -C $F/src worktree list | sed "s#$F#\$F#g"
echo "== lock file left?"; ls $F/state/update.lock 2>&1 | sed "s#$F#\$F#g"
