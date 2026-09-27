# Sample inputs

Files a person — or a journey — can feed to the platform's intake surfaces.
Every one of them is **generated**, and each is listed with the command that
regenerates it, because a sample whose provenance is unknown is an input nobody
can trust:

| File                      | What it is                                                                     | Regenerate with                                                              |
| ------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `hmis-monthly-sample.csv` | A monthly HMIS stock statement a district might send                           | Written by hand to the ministry's own column headings; see `docs/INTEROP.md` |
| `hmis-monthly-broken.csv` | The same statement with a damaged row, for the refusal path                    | As above                                                                     |     | `register-sample.png` | A **rendered page** of a paper stock register, dated 2026-09-27 (not a photograph of one) | `pnpm samples:register` |
| `voice-sample.wav`        | A **synthesised recording** of a stock update in Indian English (not a person) | `pnpm samples:voice` (macOS: uses `say` and `afconvert`)                     |

The media samples are for `e2e/live-ai.spec.ts`, which runs only when a Gemini key
is configured (`CIVORA_LIVE_AI=1`) and skips with its reason when one is not. The
voice recording is uploaded as it is; the register page is rendered _inside_ the
journey, dated the day it runs, because the day on the page is the day the
movement is recorded against — so this folder's copy is the one a person tries,
and `scripts/register-page.ts` is the single definition both use. They are served
from this folder, which the proxy matcher already excludes from correlation
handling.
