import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { resolveConfig, validateRuntimeConfig } from '../../src/runtime/config';
import { makeCamera, calibration } from '../../src/simulation/sensors/camera';
import { headMount } from '../../src/simulation/world/mount';
import { buildEpisodePlan } from '../../src/runtime/plan';

test('head optics, calibration and task coverage share the physical mounting frame', () => {
  const config = resolveConfig({ camera: { mount: 'head' } });
  const mount = headMount(config.environment.robot, config.camera.head!.pitch);
  const camera = makeCamera(config.camera, config.environment);
  assert(camera.position.distanceTo(mount.lens) < 1e-12);
  const forward = new Vector3(0, 0, 1).applyQuaternion(mount.opticalRotation);
  assert(camera.getWorldDirection(new Vector3()).distanceTo(forward) < 1e-12);
  const meta = calibration(config.camera, config.environment);
  assert.deepEqual(meta.cameraToWorld, camera.matrixWorld.toArray());
  assert.equal(meta.near, config.camera.head!.near);
  assert.equal(
    meta.intrinsics[1][1],
    config.camera.heightPixels / (2 * Math.tan((camera.fov * Math.PI) / 360)),
  );
  const [xmin, xmax, zmin, zmax] = config.scene.region;
  for (const x of [xmin, xmax])
    for (const z of [zmin, zmax])
      for (const y of [
        config.environment.tableTop + 0.025,
        config.environment.tableTop + config.scene.maxStackHeight,
      ]) {
        const point = new Vector3(x, y, z).project(camera);
        assert(Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && Math.abs(point.z) < 1);
      }
  const moved = structuredClone(config);
  moved.environment.robot.mount.column.z += 0.2;
  moved.environment.robot.mount.neck.top += 0.1;
  const shifted = makeCamera(moved.camera, moved.environment);
  assert(
    shifted.position.distanceTo(camera.position.clone().add(new Vector3(0, 0.1, 0.2))) < 1e-12,
  );
});

test('The camera configuration requires explicit camera fields and rejects invalid mounts', () => {
  const config = resolveConfig();
  const incomplete = structuredClone(config);
  delete (incomplete.camera as any).mount;
  assert.throws(() => validateRuntimeConfig(incomplete), /camera mount/);
  incomplete.camera.mount = 'external';
  delete (incomplete.camera as any).head;
  assert.throws(() => validateRuntimeConfig(incomplete));
  for (const pitch of [39, 71])
    assert.throws(
      () => resolveConfig({ camera: { head: { pitch, fov: 70, near: 0.02 } } }),
      /head camera/,
    );
  assert.throws(
    () =>
      resolveConfig({
        camera: { mount: 'head' },
        environment: { robot: { mount: { type: 'table-edge-bracket' } } },
      }),
    /robot mount/,
  );
  assert.throws(() => resolveConfig({ camera: { mount: 'invalid' as any } }), /camera mount/);
  const head = resolveConfig({ camera: { mount: 'head' } });
  assert.throws(
    () => buildEpisodePlan(head, { seeds: [42], positions: ['N', 'S'] }),
    /external positions/,
  );
  assert.equal(buildEpisodePlan(head, { seeds: [42] })[0].config.camera.mount, 'head');
});
