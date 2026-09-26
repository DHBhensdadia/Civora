# Federated learning across administrative silos — the privacy/accuracy trade-off

Generated 2026-09-26 by `pnpm fl:sweep --epsilon 1,2,4,8,16,32,64,128 --out docs/federated-tradeoff`. Do not edit by hand: this file is rewritten from the runs it describes, and an edited figure would be one nobody could reproduce.

Every number below came from a real run of the federated trainer in `packages/federated`. The
silos are administrative regions of a *simulated* world; the rounds, the clipping, the masking,
the noise and the accounting are the real implementation.

## What was run

- world SIM-IN at state level · window 2026-03-01 → 2026-09-24
- 6 silo(s) · 789 series read (0 too short to use) · 94,680 training row(s)
- censored demand: 1,637 day(s) found, 1,637 imputed (facility-mean) — a stock-out is not low demand
- model linear · 6 round(s) · sampling rate 1 · per-sample clip 1 · δ 0.00001
- FedProx proximal weight μ = 0.05 · secure aggregation by additive masking: on · seed samvad|civora-demo-2026
- round took 2,438 ms on average, measured by the command beside this document

## The trade-off

| ε target | σ solved | reachable | initial loss | final loss | improvement | note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 12.0062 | yes | 1.0000 | 89.5866 | -8858.66% |  |
| 2 | 6.1220 | yes | 1.0000 | 22.3856 | -2138.56% |  |
| 4 | 3.1765 | yes | 1.0000 | 10.2897 | -928.97% |  |
| 8 | 1.6980 | yes | 1.0000 | 4.5020 | -350.20% |  |
| 16 | 0.9374 | yes | 1.0000 | 1.4353 | -43.53% |  |
| 32 | 0.5412 | yes | 1.0000 | 0.5545 | 44.55% |  |
| 64 | 0.3381 | yes | 1.0000 | 0.3037 | 69.63% |  |
| 128 | 0.2270 | yes | 1.0000 | 0.2191 | 78.09% |  |

In the shared basis the target has unit variance, so the zero model's loss is exactly 1 and a run's improvement is the share of the demand's variance it explained. With no mechanism at all — the same rounds over the same rows — the run explained 83.42% of it. At ε = 1 — the smallest target this sweep reached, with σ = 12.0062 — it explained -8858.66%, and at ε = 128 it explained 78.09%. 5 of the 8 reachable targets left the model **worse than predicting the pooled mean** (loss above 1): at those ε values the mechanism's noise did more damage than the rounds did good. The gap between the run with no mechanism and the smallest target is what the privacy costs there, and it is stated rather than smoothed away.

The improvement column is `1 − finalLoss / initialLoss` in the **shared basis**, where the
target has unit variance: a loss of `1` is what a model that predicts the pooled mean scores, so
the improvement is the share of the demand’s variance the run explained. It is not a percentage of
anything a hospital measured — the target is recorded demand in a generated world — and it is
comparable across rows because every row starts from the same zero model over the same rows.

**Read the curve before quoting a figure from it.** the smallest target that beat predicting the pooled mean was ε = 32 (loss 0.5545, explaining 44.55% of the demand’s variance); 5 of 8 target(s) in the swept range left the model worse than that.

per-coordinate noise is σ · clip · w_max, and w_max = 0.1698 here — the largest of 6 silos, holding 16,080 of 94,680 rows. More silos means a smaller w_max, and the same ε then buys less noise.

The multiplier σ is the accountant’s own answer: the sweep solves for the noise multiplier that
spends exactly the target ε over these rounds at this sampling rate, by bisecting the accounting
computation, so the ε on a row and the σ on that row cannot disagree.

## FedAvg against FedProx

| variant | proximal weight μ | final loss | better |
| --- | --- | --- | --- |
| FedAvg | 0 | 0.1498 | **yes** |
| FedProx | 0.05 | 0.1658 | no |

On this partition, plain FedAvg reached the lower loss. Both figures are reported whichever way it falls: a proximal term that loses on a given partition is a finding about that partition, and hiding it would make the technique look like a guarantee.

## Local-only against federated, per silo

The local-only column is a model trained on that silo’s rows alone, from the same zero model,
with the same epochs, batch size and optimiser — so the difference between the two columns is the
federation and nothing else.

| silo | rows | local-only loss | federated loss | difference | verdict |
| --- | --- | --- | --- | --- | --- |
| `SIM-ODISHA` | 16,080 | 0.2469 | 0.2760 | -0.0291 | training alone lower |
| `SIM-BIHAR` | 16,080 | 0.3006 | 0.3175 | -0.0169 | training alone lower |
| `SIM-MAHARA` | 15,480 | 0.1050 | 0.0943 | +0.0107 | federation lower |
| `SIM-TAMIL-` | 15,480 | 0.0970 | 0.0901 | +0.0069 | federation lower |
| `SIM-KERALA` | 15,480 | 0.1398 | 0.1262 | +0.0136 | federation lower |
| `SIM-UTTAR-` | 16,080 | 0.0994 | 0.0834 | +0.0159 | federation lower |

4 of 6 silos ended lower under the federation; 2 ended lower trained alone. Weighted over the rows, local-only 0.1658 against federated 0.1658 (94,680 rows). Federation does not help everywhere, and a partition where it does not is a result rather than a failure — the cold-start path and the data-sovereignty property hold either way.

## What this document does not claim

- This is a reference implementation of the federation algorithm and control plane, running on locally partitioned data. It is not a deployed multi-organisation federation. The production substrate is a private GKE cluster with TensorFlow Federated and the Federated Compute Platform, per Google Cloud’s published reference architecture.
- The production substrate is cited, not built: Google Cloud — cross-silo federated learning on private GKE, with TensorFlow Federated and the Federated Compute Platform (see decisions/0006 and research/03 §7).
- The world, its facilities, its consumption and its stock-outs are generated. Every silo here is a simulated region, and every row of every table is simulated end to end.
- No figure was chosen to make the curve look better. A target the accountant could not reach is printed as unreachable with its own sentence, and a silo where federation lost is printed as a loss.
- The comparison tables ran with **no mechanism at all**, because they answer a different question from the curve: a silo training alone needs no privacy mechanism, so a priced federated model compared against a noise-free local one would measure the noise and call it the federation. Under DP the honest comparison is the curve above.
- The privacy cost is not free and this document does not present it as free: the smallest target that beat predicting the pooled mean was ε = 32 (loss 0.5545, explaining 44.55% of the demand’s variance); 5 of 8 target(s) in the swept range left the model worse than that.
- That a useful ε is out of reach at six silos is a measurement about this configuration, not a defect in the mechanism. It is also why the federated-statistics path exists: sums and counts are the part that survives a small cohort, and the cold-start prior they feed is measured in the same runs.
- The rounds ran on one machine, partitioned by region in code. Physical separation by machine and organisation is the deployment story in the ADR, not a property of this build.

## The tests the privacy claim rests on

- `pnpm --filter @civora/federated test` — the payload assertion: the real outbound payload is serialised, checked against a field allow-list **and** scanned for sentinel values planted in the silo’s raw records. It is shown to fire on a payload built to leak.
- `packages/federated/src/accountant.test.ts` — the accounting is checked against the published closed-form bounds of the sampled Gaussian mechanism (Mironov, Talwar & Zhang 2019, arXiv:1908.10530, Table 1).
- `packages/federated/src/masking.test.ts` — masking preserves the sum exactly and changes nothing an individual silo can be identified by; two assignments of the same update are indistinguishable to the coordinator.
- `packages/federated/src/coordinator.test.ts` — a round is a pure function of the silos, the configuration and the seed, and the noise is standardised to the clipped sensitivity.

## Reproducing this document

```bash
pnpm fl:sweep --epsilon 1,2,4,8,16,32,64,128 --out docs/federated-tradeoff
```

The same curve is drawn from the same code by the Federation Console, at a smaller resolution, so
the surface and this document cannot disagree about what was run.

