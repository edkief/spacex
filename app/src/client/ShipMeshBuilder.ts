import * as THREE from 'three';
import { Livery, SHIP_CLASSES, ShipClassId } from '../shared/ships';

export class ShipMeshBuilder {
  private hullMaterial = new THREE.MeshStandardMaterial();
  private accentMaterial = new THREE.MeshStandardMaterial();
  private trimMaterial = new THREE.MeshStandardMaterial();

  /**
   * Creates a basic ship mesh with identified paint zones.
   * @param classId The class of ship to build.
   */
  build(classId: ShipClassId): THREE.Group {
    const group = new THREE.Group();

    // Hull - Main body
    const hullGeo = new THREE.BoxGeometry(1, 0.5, 2);
    const hullMesh = new THREE.Mesh(hullGeo, this.hullMaterial);
    group.add(hullMesh);

    // Accent - Side panels
    const accentGeo = new THREE.BoxGeometry(0.1, 0.4, 1);
    const accentL = new THREE.Mesh(accentGeo, this.accentMaterial);
    accentL.position.set(0.5, 0, 0);
    group.add(accentL);

    const accentR = new THREE.Mesh(accentGeo, this.accentMaterial);
    accentR.position.set(-0.5, 0, 0);
    group.add(accentR);

    // Trim - Details
    const trimGeo = new THREE.BoxGeometry(0.8, 0.1, 0.1);
    const trimMesh = new THREE.Mesh(trimGeo, this.trimMaterial);
    trimMesh.position.set(0, 0.25, 0.8);
    group.add(trimMesh);

    return group;
  }

  /**
   * Updates the materials of the ship to match the provided livery.
   * @param livery The livery colors to apply.
   */
  applyLivery(livery: Livery) {
    this.hullMaterial.color.set(livery.hull);
    this.accentMaterial.color.set(livery.accent);
    this.trimMaterial.color.set(livery.trim);
  }

  /**
   * Sets the default livery for a ship class.
   * @param classId The ship class.
   */
  applyDefaultLivery(classId: ShipClassId) {
    const defaults = SHIP_CLASSES[classId].defaultLivery;
    this.applyLivery(defaults);
  }
}
