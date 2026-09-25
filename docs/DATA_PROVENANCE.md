# Data provenance

Every dataset this project uses is recorded here with its source, licence,
retrieval date and the transformation applied to it. The rule is absolute: a
record whose origin cannot be established is not used.

## Current state

**No external dataset has been incorporated yet.** At this commit the repository
contains no health data of any kind. The facility network, consumption history
and stock positions the platform is designed around do not exist yet; they will
be produced by the simulator and will be labelled as simulated wherever they
appear — in the interface, in API responses and in this file.

## Datasets in use

| Dataset    | Source | Licence | Retrieved | Transformation | Used for |
| ---------- | ------ | ------- | --------- | -------------- | -------- |
| _none yet_ |        |         |           |                |          |

## Datasets expected

Each of the following will get a row above, with its licence and retrieval date,
in the same change that introduces the code that reads it. They are named here
so that provenance is designed in rather than retrofitted:

- **Administrative geography** — district and block codes used to identify
  facilities and to aggregate upwards.
- **Facility registry** — the public health facilities within the modelled
  states and their administrative parents.
- **National list of essential medicines** — the item catalogue, its
  presentations and its cold-chain requirements.
- **Incumbent reporting formats** — the stock and consumption reporting layouts
  the importers will accept.
- **Published consumption and stock-out studies** — used only to calibrate the
  simulator's behaviour so that the synthetic nation behaves like the real one.

## What is simulated

Everything. This prototype simulates a national network; it is not connected to
one. No real facility, patient, prescription or stock record is read, stored or
processed by this repository, and no personal health information is collected by
construction.
