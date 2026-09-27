#!/usr/bin/env bash
#
# Regenerate the spoken sample the live voice check hears.
#
#     pnpm samples:voice
#
# The file this writes — `apps/web/public/samples/voice-sample.wav` — is what
# `e2e/live-ai.spec.ts` uploads when a Gemini key is configured. It is the
# system's own speech synthesis speaking a stock update in Indian English, not a
# person: the journey that uses it says so, because a clean synthetic recording
# is an easier listen than a phone recording of a ward and claiming otherwise
# would overstate what the live check proves.
#
# macOS only, and it says so rather than failing obscurely: `say` and `afconvert`
# are the system's; on another platform a person records the same sentence and
# holds the file where this one would be.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="$REPO_ROOT/apps/web/public/samples/voice-sample.wav"
SCRATCH="$REPO_ROOT/.cache/voice-sample.aiff"

if ! command -v say >/dev/null 2>&1 || ! command -v afconvert >/dev/null 2>&1; then
  echo "say/afconvert were not found: this script synthesises the recording with macOS's own" >&2
  echo "speech engine. On another platform, record the same sentence and write it to" >&2
  echo "$OUTPUT as 16 kHz mono WAV." >&2
  exit 2
fi

# The words matter: a quantity spoken as a word (\"twenty\" is 20), a batch and an
# expiry, and the medicine named in English the way a pharmacist would say it —
# the model has to transcribe without computing, and the platform matches the
# name itself.
SENTENCE="Stock update from the PHC. Twenty paracetamol five hundred milligram tablets arrived today. Batch B seventy seven. Expiry December twenty twenty seven."

mkdir -p "$(dirname "$SCRATCH")"
say -v Rishi -o "$SCRATCH" "$SENTENCE"
mkdir -p "$(dirname "$OUTPUT")"
afconvert -f WAVE -d LEI16@16000 -c 1 "$SCRATCH" "$OUTPUT"
rm -f "$SCRATCH"

echo "wrote $OUTPUT ($(wc -c <"$OUTPUT" | tr -d ' ') bytes)"
