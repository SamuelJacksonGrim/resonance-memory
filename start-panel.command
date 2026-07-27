#!/bin/bash
# macOS launcher. First time: right-click -> Open (Gatekeeper), then it just works.
cd "$(dirname "$0")"
echo "Starting Resonance Memory control panel..."
echo "A browser tab will open. Keep this window open while you use the panel."
node panel.js
