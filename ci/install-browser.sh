#!/usr/bin/env bash
set -euo pipefail

# The hosted runner also configures Google's system Chrome repository. These
# tests use Playwright's pinned Chromium download, not that system package.
# Exclude the unused repository so its index publication/hash failures cannot
# block installation of Chromium's Ubuntu dependencies. Apt verification stays on.
sudo rm -f /etc/apt/sources.list.d/google-chrome.list /etc/apt/sources.list.d/google-chrome.sources
npx playwright install --with-deps chromium
