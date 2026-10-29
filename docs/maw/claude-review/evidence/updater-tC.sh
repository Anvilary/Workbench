. "$(dirname "$0")/updater-fixture-lib.sh"
races=0; n=10
for i in $(seq 1 $n); do
  mkfixture; push_commit two; git -C $F/src reset -q --hard HEAD~1
  # two updaters started at the same instant (e.g. double-click / two tabs)
  PNPM_SLEEP=1 sh $UPD --no-restart --ref origin/main > $F/c1.out 2>&1 & a=$!
  PNPM_SLEEP=1 sh $UPD --no-restart --ref origin/main > $F/c2.out 2>&1 & b=$!
  wait $a; ea=$?; wait $b; eb=$?
  installs=$(grep -c '^pnpm install' $F/fix.log)
  lockmsg=$(cat $F/c1.out $F/c2.out | grep -c 'Another MAW update is already in progress')
  [ "$installs" -ge 2 ] && races=$((races+1))
  echo "run $i: exits=$ea/$eb concurrent-installs=$installs lock-rejections=$lockmsg $(cat $F/c1.out $F/c2.out | grep -m1 -o 'already exists' )"
done
echo "TOCTOU lock bypassed in $races/$n runs"
