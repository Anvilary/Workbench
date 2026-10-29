. "$(dirname "$0")/updater-fixture-lib.sh"; mkfixture
push_commit two; git -C $F/src reset -q --hard HEAD~1; sh $UPD --no-restart --ref origin/main >/dev/null 2>&1; git -C $F/src merge -q --ff-only origin/main
echo "after normal update: current release commit $(grep -o '"commit":"[0-9a-f]\{7\}' $F/state/current/.maw-release-meta.json | cut -d'"' -f4)"
git -C $F/src switch -q -c feature/wip; echo wip > $F/src/packages/server/src/experimental.ts; git -C $F/src add -A; git -C $F/src commit -qm "WIP experimental"; git -C $F/src push -q -u origin feature/wip 2>/dev/null
echo "-- developer on pushed feature branch runs plain 'maw update --no-restart':"
sh $UPD --no-restart 2>&1 | grep -E "staged succ|Error" | sed "s#$F#\$F#g"
echo "deployed: $(grep -o '"commit":"[0-9a-f]\{7\}' $F/state/current/.maw-release-meta.json | cut -d'"' -f4) | feature/wip=$(git -C $F/src rev-parse --short feature/wip) | origin/main=$(git -C $F/src rev-parse --short origin/main)"
ls $F/state/current/packages/server/src/
