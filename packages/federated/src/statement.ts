/**
 * The honesty boundary, in one place so the Console, the generated report and
 * the tests cannot drift apart on the wording.
 *
 * ADR 0006 requires this statement **in the product itself**, not only in the
 * documentation: the algorithm and control plane are real and run on locally
 * partitioned data, and the managed multi-organisation substrate is a
 * documented production path that this prototype does not operate. A federation
 * demo that reads as a live multi-state deployment would be the project's
 * largest overclaim, and the ADR forbids it by name.
 */

export const FEDERATION_HONESTY_BOUNDARY =
  'This is a reference implementation of the federation algorithm and control plane, running on locally partitioned data. It is not a deployed multi-organisation federation. The production substrate is a private GKE cluster with TensorFlow Federated and the Federated Compute Platform, per Google Cloud’s published reference architecture.';

export const FEDERATION_ARCHITECTURE_REFERENCE =
  'Google Cloud — cross-silo federated learning on private GKE, with TensorFlow Federated and the Federated Compute Platform (see decisions/0006 and research/03 §7)';

/** One sentence for a caption, citing the architecture without repeating it all. */
export const FEDERATION_SUBSTRATE_NOTE =
  'The production substrate — private GKE, TensorFlow Federated, the Federated Compute Platform — is documented and cited, not built.';
