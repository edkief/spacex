import * as THREE from 'three';

/**
 * TASK-36: the placeholder character model — extracted out of WorldManager
 * so the remote-entity render layer (remote-entities.ts) can build the SAME
 * capsule for remote players without a WorldManager → remote-entities →
 * WorldManager import cycle.
 *
 * A lit-free capsule body + head in a group whose ORIGIN is the character's
 * FEET (the physics pos). Local +Z is forward (the physics facing quat), so
 * a facing quat orients the model directly. Replaced by the real model in a
 * later pass.
 */

/** Default model colors (re-tinted by the ship livery — TASK-32). */
export const DEFAULT_CHARACTER_BODY = '#7dd3fc';
export const DEFAULT_CHARACTER_HEAD = '#e2e8f0';

/**
 * One character model (local or remote — same mesh both sides). The caller
 * owns the group's parentage + disposal.
 */
export function buildCharacterMesh(): {
  group: THREE.Group;
  body: THREE.MeshBasicMaterial;
  head: THREE.MeshBasicMaterial;
} {
  const group = new THREE.Group();
  const body = new THREE.MeshBasicMaterial({ color: DEFAULT_CHARACTER_BODY });
  const bodyMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 1.2, 4, 8), body);
  bodyMesh.position.y = 1.05; // capsule center: 2.1 m tall on the feet
  const head = new THREE.MeshBasicMaterial({ color: DEFAULT_CHARACTER_HEAD });
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), head);
  headMesh.position.y = 1.95; // above the capsule
  group.add(bodyMesh, headMesh);
  return { group, body, head };
}
