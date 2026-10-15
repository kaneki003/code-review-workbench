#!/bin/sh
set -eu
prototype_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${CRW_PROTOTYPE_NAMED_PROFILE:-0}" = 1 ]; then
  exec code --new-window --profile 'CRW disposable host prototype' --extensionDevelopmentPath "$prototype_dir" "$prototype_dir/fixture"
fi
profile_dir=${CRW_PROTOTYPE_PROFILE:-/private/tmp/crw-native-host-profile}
exec code --new-window --user-data-dir "$profile_dir" --extensions-dir "$profile_dir/extensions" --extensionDevelopmentPath "$prototype_dir" "$prototype_dir/fixture"
