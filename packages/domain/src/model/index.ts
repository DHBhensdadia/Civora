/**
 * The domain model.
 *
 * Schemas only, plus the constants that belong to the shapes they describe.
 * Behaviour lives in `./logic`, which is pure and has no idea where its inputs
 * came from.
 */

export * from './common';
export * from './identity';
export * from './administrative';
export * from './catalogue';
export * from './sensing';
export * from './derived';
export * from './intelligence';
export * from './coordination';
