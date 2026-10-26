// Roughly half the clock text's width (~16.4 units at scale 2), so the camera
// centres on the text rather than its left-anchored inner end. A plain module
// so the camera code can size its near plane and closest approach by it
// without importing the label components.
export const CLOCK_HALF_WIDTH = 8
