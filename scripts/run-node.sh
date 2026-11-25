#!/bin/sh

# A Finder or Dock launch may omit the package manager's bin directories.
if [ "$(/usr/bin/uname -s)" = Darwin ]; then
  PATH="${PATH:+$PATH:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  export PATH
fi

exec node "$@"
