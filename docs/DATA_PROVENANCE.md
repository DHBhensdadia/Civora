# Data provenance

Every dataset this project uses is recorded here with its source, licence,
retrieval date and the transformation applied to it. The rule is absolute: a
record whose origin cannot be established is not used.

## Current state

The repository contains **no real health data**. There is no facility register,
no patient record and no stock ledger from any real system, and nothing here has
been read from or written to a health information system.

What it does contain is a simulator, and the simulator is anchored: the district
populations it uses, the medicines it stocks and the facility norms it sites
against are real published values, retrieved and recorded below. Everything the
platform actually reasons about — stock positions, consumption, presentations,
reporting — is generated from those anchors plus the stated assumptions in the
next section.

Every generated record carries `synthetic: true` and a `provenance` naming this
repository's simulator, and the assertion that no record can be displayed without
those two fields is part of the test suite.

## Datasets in use

| Dataset | Source | Licence | Retrieved | Transformation | Used for |
| ------- | ------ | ------- | --------- | -------------- | -------- |
| Odisha district populations | Census of India 2011, compiled district listing (`census2011.co.in`) | Government of India census data, attributed | 2026-09-25 | All 30 districts read and used verbatim | District populations and the demand they imply |
| Bihar district populations | Census of India 2011, compiled district listing | Government of India census data, attributed | 2026-09-25 | All 38 districts read and used verbatim | District populations and the demand they imply |
| State populations | Census of India 2011, compiled state listing | Government of India census data, attributed | 2026-09-25 | 24 states and the national total read; the listing was truncated before the smaller states and union territories, which are allocated instead (see assumptions) | Region populations, and the residual the allocated states divide |
| National List of Essential Medicines 2022 | Central Drugs Standard Control Organisation, Ministry of Health and Family Welfare (PDF) | Government of India publication, retrieved and parsed for reference values | 2026-09-25 | Section codes, generic names, dosage forms, strengths and level-of-care markers extracted locally with `pdftotext`; 74 items carried into the catalogue | The item catalogue, its levels of care and its surge sensitivity |
| Indian Public Health Standards — sub-centre norm | Cited in Kataria GM et al., *Journal of Family Medicine and Primary Care*, 2023 | Open access; cited, not reproduced | 2026-09-25 | One sub-centre per 5,000 population in plain areas, 3,000 in difficult areas | Sub-centre catchment bands |
| Indian Public Health Standards — primary health centre norm | Indian Health Facility Guidelines (MoHFW-aligned reference) | Government of India reference material; ranges cited | 2026-09-25 | 20,000 population in difficult areas, 30,000 elsewhere | Primary health centre catchment bands |
| Local Government Directory — district and block codes | Ministry of Panchayati Raj | Government of India directory | 2026-09-25 | **Not retrieved.** The district table is served through an interactive dashboard with no static listing | Nothing. Every administrative identifier in the dataset is prefixed `SIM-` and is synthetic |
| Integrated Disease Surveillance Programme — syndrome taxonomy | National Centre for Disease Control, MoHFW | Government of India | 2026-09-25 | **Not retrieved.** The syndrome list in the domain model is a plausible clinical grouping, not the programme's taxonomy | Syndrome names, documented as an assumption |
| Rural Health Statistics — facility counts by state | Ministry of Health and Family Welfare | Government of India | 2026-09-25 | **Not retrieved.** Facility counts are derived from population and the IPHS norms rather than read from a published count | Nothing directly; facility counts are derived |

A source that could not be retrieved is recorded above as a failure and is never
substituted with a plausible-looking replacement. The two consequential gaps are
both visible in the data: no identifier claims to be an official LGD code, and
Oral Rehydration Salts are absent from the catalogue because their section code
could not be extracted from the parsed NLEM text — a recorded gap rather than an
invented code.

## Assumptions

Values NLEM, the census and IPHS do not carry, derived by documented rule
instead. Each is an order-of-magnitude figure chosen to be plausible at the scale
of a primary health centre; none is measured, and Phase 4 replaces the
consumption figures with anything better that can be obtained.

### Geography and facilities

| Assumption | Value | Where it lives |
| ---------- | ----- | -------------- |
| State populations not covered by the truncated census listing | Residual of the national total, divided by documented relative weights, each state marked `assumption` in its own record | `anchors/geography.ts` |
| District populations for states with no census district table | 2–6% of the state total, drawn per district | `network.ts` |
| District populations for generated districts | Equal share of the state total | `network.ts` |
| Block populations | District population divided by the number of blocks modelled | `network.ts` |
| State centroids | Approximate positions in decimal degrees, good enough to place a marker in the right state and not good enough to navigate by | `network.ts` |
| Coordinate jitter | ±0.6° around the state centroid, so no coordinate is a real facility's location | `network.ts` |
| Urban share by state | Published approximate figures, jittered ±40% per district | `anchors/geography.ts` |
| Community health centre norms | 80,000–120,000 population, 30 beds | `packages/domain/src/model/administrative.ts` |
| Connectivity by tier | A higher tier is likelier to report reliably | `network.ts` |
| Cold-chain availability by tier | 92% of community health centres, 70% of primary health centres, 35% of sub-centres | `network.ts` |

### Consumption

| Assumption | Value | Where it lives |
| ---------- | ----- | -------------- |
| Units dispensed per reported case | Analgesic 3.5, antibiotic 0.22, antimalarial 0.1, rehydration 2.4, intravenous fluid 0.07; zero for the rest | `anchors/catalogue.ts` |
| Routine consumption, units per 1,000 catchment per day | Antidiabetic 7, cardiovascular 9, maternal health 3.5, antibiotic 1.5, vaccine 1.5, analgesic 1.2, programme TB 0.8, other 2, programme HIV 0.2 | `anchors/catalogue.ts` |
| Presentations per 1,000 catchment per day | Fever 2.4, cough 1.7, diarrhoea 0.62, rash 0.28, conjunctivitis 0.14, jaundice 0.07, bleeding 0.04, neurological 0.03 | `behaviour.ts` |
| Share of a district's presentations seen by tier | Sub-centre 0.45, Ayushman Arogya Mandir 0.5, primary health centre 1.0, community health centre 1.25 | `behaviour.ts` |
| Seasonality | A monthly multiplier peaking at 1.5 in August, applied to fever, cough, diarrhoea and routine consumption; other syndromes are flat | `behaviour.ts` |
| Weekday pattern | Sunday 0.55 of an ordinary day, Saturday 0.72 | `behaviour.ts` |
| Day-to-day variation | Multiplicative, bounded at ±54%, symmetric | `behaviour.ts` |
| Unit, pack size, shelf life and storage class | Derived by rule from dosage form and category; insulin, oxytocin and vaccines are the cold-chain exceptions | `anchors/catalogue.ts` |

### Stock, ordering and reporting

| Assumption | Value | Where it lives |
| ---------- | ----- | -------------- |
| Opening cover | 40 days of demand | `behaviour.ts` |
| Reorder point | 14 days of cover; 90 in the no-transfer control | `behaviour.ts`, `scenarios.ts` |
| Ordering target | 30 days of cover; 120 in the no-transfer control | `behaviour.ts`, `scenarios.ts` |
| Review period | One weekday a week | `behaviour.ts` |
| Lead time | Sub-centre 12 days, primary health centre 8, community health centre 5 | `behaviour.ts` |
| Demand the ordering rule learns from | Mean of the last 28 days of recorded issues — the facility's own censored history, which is the failure the platform exists to correct | `behaviour.ts` |
| Short-dated opening batches | 10% of item-facility pairs, expiring 45–110 days into the window | `behaviour.ts` |
| Expiry write-off | A batch is withdrawn the day before it expires, because the ledger requires a movement on a day the batch was still valid | `behaviour.ts` |
| Cold-chain failure loss | 70% of cold-chain stock, recorded as a downward adjustment rather than an expiry, because it did not expire | `behaviour.ts` |
| Expiry cliff delivery | 180 days of demand per item, expiring 45 days after it arrives | `behaviour.ts` |
| Reporting probability by connectivity | Good 0.97, intermittent 0.86, poor 0.62, none 0.14 | `behaviour.ts` |
| Incidental outages | 0.4% chance per facility-day of a 3–9 day silence | `behaviour.ts` |
| Offline capture | A silent facility keeps working; its records are dated when they were captured and delivered when it reconnects | `behaviour.ts` |
| Bed occupancy | 58% ordinarily, up to 22 points higher at a fever surge peak | `behaviour.ts` |
| Outpatient attendances | 14 per 1,000 catchment per day, of which 5% are admitted | `behaviour.ts` |
| Posts filled and present | 82% of sanctioned posts filled; 88% of those present on a given day | `behaviour.ts` |
| Staff mix | Documented shares per cadre, applied to the facility's sanctioned posts | `behaviour.ts` |

## What is simulated

Everything the platform reasons about. This prototype simulates a national
network; it is not connected to one. No real facility, patient, prescription or
stock record is read, stored or processed by this repository, and no personal
health information is collected by construction — there is nowhere in the model
to put a person, and staff attendance is recorded as counts of posts rather than
as people.

Two things are *not* simulated and are worth stating plainly, because conflating
them would misrepresent the prototype: the anchored values above are real
published figures, and the redistribution and forecasting methods in the
application are real implementations operating on simulated data. The federation
control plane is real; a deployed multi-organisation federation is not, and the
console says so where it is shown.
