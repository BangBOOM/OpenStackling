import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { WorldScene } from '../../runtime/browser/render/rendering';
// Layer 1 is a display overlay. Sensor cameras only render layer 0.
export class JointOverlay {
  readonly labels = new CSS2DRenderer();
  private entries: {
    objects: THREE.Object3D[];
    material: THREE.MeshStandardMaterial;
    arrow: THREE.ArrowHelper;
    label: CSS2DObject;
    level: number;
  }[] = [];
  private markers = true;
  private annotations = false;
  constructor(
    private world: WorldScene,
    host: HTMLElement,
  ) {
    this.labels.domElement.style.cssText =
      'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    host.append(this.labels.domElement);
    const c = world.sim.config.environment.robot;
    world.robotMeshes.forEach((group, index) => {
      const i = index % 6,
        arm = Math.floor(index / 6);
      const axis = new THREE.Vector3(...(c.axes[i] as [number, number, number])),
        rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
      const radius = [0.105, 0.095, 0.08, 0.052, 0.052, 0.052][i],
        tube = i < 3 ? 0.005 : 0.0035,
        offset = (i < 3 ? 0.09 : 0.04) / 2 + 0.008;
      const material = new THREE.MeshStandardMaterial({
        color: '#9a4f33',
        emissive: '#ffa16a',
        emissiveIntensity: 0.15,
        roughness: 0.5,
      });
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, tube, 8, 32, Math.PI * 0.62),
        material,
      );
      ring.quaternion.copy(rotation);
      ring.position.copy(axis).multiplyScalar(offset);
      const start = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation),
        needle = new THREE.Mesh(new THREE.BoxGeometry(0.022, tube * 1.5, tube * 1.5), material);
      needle.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), start);
      needle.position.copy(ring.position).addScaledVector(start, radius + 0.011);
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(0.022, tube * 1.5, tube * 1.5),
        new THREE.MeshStandardMaterial({ color: '#594d3e' }),
      );
      tick.quaternion.copy(needle.quaternion);
      tick.position.copy(needle.position);
      if (i > 0) tick.position.x += c.links[i - 1];
      (i === 0 ? world.armAnchors[arm] : world.robotMeshes[index - 1]).add(tick);
      group.add(ring, needle);
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(),
        0.16,
        0xb98045,
        0.025,
        0.012,
      );
      world.scene.add(arrow);
      const el = document.createElement('div');
      el.className = 'joint-label';
      const label = new CSS2DObject(el);
      world.scene.add(label);
      for (const o of [ring, needle, tick, arrow, label])
        o.traverse((child) => child.layers.set(1));
      this.entries.push({ objects: [ring, needle, tick], material, arrow, label, level: 0 });
    });
    this.setAnnotations(false);
  }
  setMarkers(value: boolean) {
    this.markers = value;
    this.entries.forEach((e) => e.objects.forEach((o) => (o.visible = value)));
  }
  setAnnotations(value: boolean) {
    this.annotations = value;
    this.entries.forEach((e) => {
      e.arrow.visible = value;
      e.label.visible = value;
    });
  }
  update(camera: THREE.Camera, dt: number) {
    const c = this.world.sim.config.environment.robot;
    let changing = false;
    this.entries.forEach((entry, index) => {
      const i = index % 6,
        arm = this.world.sim.arms[Math.floor(index / 6)],
        state = arm.state();
      const body = arm.bodies[i],
        axis = new THREE.Vector3(...(c.axes[i] as [number, number, number])).applyQuaternion(
          new THREE.Quaternion().copy(body.rotation()),
        ),
        v = body.angvel(),
        parent = i > 0 ? arm.bodies[i - 1].angvel() : arm.base.angvel();
      const target = Math.min(
          1,
          Math.abs(
            (v.x - parent.x) * axis.x + (v.y - parent.y) * axis.y + (v.z - parent.z) * axis.z,
          ) / 0.15,
        ),
        next = THREE.MathUtils.damp(entry.level, target, 12, dt);
      if (Math.abs(next - entry.level) > 0.001 && this.markers) changing = true;
      entry.level = next;
      entry.material.emissiveIntensity = 0.15 + next * 1.2;
      entry.material.color.lerpColors(new THREE.Color('#9a4f33'), new THREE.Color('#ec8b45'), next);
      if (this.annotations) {
        entry.arrow.position.copy(body.translation());
        entry.arrow.setDirection(axis);
        entry.label.position.copy(body.translation()).addScaledVector(axis, i < 3 ? 0.18 : 0.12);
        entry.label.element.textContent = `${index < 6 ? 'L ' : 'R '}q${i + 1} · ${THREE.MathUtils.radToDeg(state[i]).toFixed(1)}°`;
      }
    });
    this.labels.render(this.world.scene, camera);
    return changing;
  }
  dispose() {
    const geometries = new Set<THREE.BufferGeometry>(),
      materials = new Set<THREE.Material>();
    for (const entry of this.entries) {
      for (const object of [...entry.objects, entry.arrow, entry.label]) {
        object.removeFromParent();
        object.traverse((child) => {
          if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
            geometries.add(child.geometry);
            for (const material of Array.isArray(child.material)
              ? child.material
              : [child.material])
              materials.add(material);
          }
        });
      }
      entry.label.element.remove();
    }
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    this.labels.domElement.remove();
  }
}
