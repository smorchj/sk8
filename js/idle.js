// idle.js — the standing idle, straight from creategamecharacters.ai's
// animation doc (/agent/integration/animation.md, "Example Procedures").
//
// The doc's Rig.rot(name, axis, angle) accumulates a LOCAL delta per bone and
// apply() writes rest * delta. This repo's rig.js already speaks exactly that:
// addRot(buffer, name, axis, angle) multiplies onto the bind-relative delta and
// Rig.apply(buffer) writes gccRestQ * delta. So basePose/idle below are the
// doc's code verbatim, with rig.rot -> addRot on a PoseBuffer.

import { clearBuffer, addRot } from './rig.js';

function basePose(rig) {
  addRot(rig, 'UpperArmL', 'z', 0.45);        // arms down: L +Z, R −Z (§3)
  addRot(rig, 'UpperArmR', 'z', -0.45);
  addRot(rig, 'LowerArmL', 'x', -0.10);       // tiny elbow ease so arms don't lock straight
  addRot(rig, 'LowerArmR', 'x', -0.10);
}

export function idle(rig, t) {                // t = seconds, per-character random offset
  clearBuffer(rig);
  basePose(rig);
  addRot(rig, 'Spine_03', 'x', Math.sin(t * 1.9) * 0.02 + 0.01);   // breathing
  addRot(rig, 'Spine_01', 'z', Math.sin(t * 0.45) * 0.02);         // weight shift
  addRot(rig, 'Head', 'y', Math.sin(t * 0.32) * 0.06);             // slow look-around
  addRot(rig, 'UpperArmL', 'x', Math.sin(t * 0.8) * 0.02);
  addRot(rig, 'UpperArmR', 'x', Math.sin(t * 0.8 + 2) * 0.02);
  return rig;
}
