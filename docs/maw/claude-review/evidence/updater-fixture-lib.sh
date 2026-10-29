# Disposable fixture for maw-update.sh / maw-restart-helper.sh. Never touches real state.
REPO=$(git rev-parse --show-toplevel)
UPD=$REPO/scripts/maw/maw-update.sh
HELPER=$REPO/scripts/maw/maw-restart-helper.sh
mkfixture() {
  F=$(mktemp -d "${TMPDIR:-/tmp}/maw-audit.XXXX")
  mkdir -p $F/bin $F/state $F/runtime; chmod 700 $F/runtime
  git init -q --bare $F/origin.git; git -C $F/origin.git symbolic-ref HEAD refs/heads/main
  git clone -q $F/origin.git $F/src 2>/dev/null
  git -C $F/src config user.name t; git -C $F/src config user.email t@e
  mkdir -p $F/src/packages/server/src; echo v1 > $F/src/packages/server/src/maw-host.ts
  echo '{"name":"x"}' > $F/src/package.json
  git -C $F/src add -A; git -C $F/src commit -qm c1; git -C $F/src branch -M main; git -C $F/src push -qu origin main 2>/dev/null
  # first install exactly like install.sh: current -> developer checkout
  ln -s $F/src $F/state/current
  cat > $F/bin/corepack <<'S'
#!/bin/sh
[ "$1" = pnpm ] && shift
echo "pnpm $* (pid $$)" >> "$FIXLOG"
[ -n "${PNPM_SLEEP:-}" ] && [ "$1" = build ] && sleep "$PNPM_SLEEP"
exit 0
S
  chmod +x $F/bin/corepack
  export FIXLOG=$F/fix.log PATH=$F/bin:$PATH MAW_STATE_DIR=$F/state MAW_RUNTIME_DIR=$F/runtime MAW_SOURCE_DIR=$F/src MAW_UNIT=maw-fixture-$$.service
}
push_commit() { echo "$1" > $F/src/packages/server/src/feat-$1.ts; git -C $F/src add -A; git -C $F/src commit -qm "$1"; git -C $F/src push -q origin main 2>/dev/null; }
show() { echo "current -> $(readlink $F/state/current | sed "s#$F#\$F#")"; echo "previous -> $(readlink $F/state/previous 2>/dev/null | sed "s#$F#\$F#")"; }
