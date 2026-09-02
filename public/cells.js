// Cell kinds and player poses. Kept in their own module so patterns.js and
// engine.js can both use them without importing each other: engine.js needs the
// pattern library, and the library names cell kinds at module-evaluation time,
// so a cycle would hit the temporal dead zone rather than merely being untidy.

// A low obstacle must be jumped, a high one must be ducked under. Standing
// upright is fatal to both, so every obstacle asks which verb, not just when.
export const EMPTY = 0;
export const LOW = 1;
export const HIGH = 2;

export const POSE = { STAND: "stand", AIR: "air", DUCK: "duck" };
