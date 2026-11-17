use crate::config::Shape;
use crate::{
    actuator::{Actuator, double_rotation, double_vector, vector},
    config::*,
};
use glam::DVec3;
use parry3d::utils::PoseOpt;
use rapier3d::prelude::*;
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FingerState {
    position: f64,
    velocity: f64,
    reference: f64,
    reference_velocity: f64,
    requested_force_estimate: f64,
    limited_force_estimate: f64,
}
pub struct Arm {
    pub bodies: Vec<RigidBodyHandle>,
    pub fingers: Vec<RigidBodyHandle>,
    joints: Vec<ImpulseJointHandle>,
    references: [f64; 2],
    velocities: [f64; 2],
    commanded_gap: f64,
    target_gap: f64,
}
pub struct World {
    pub physics: PhysicsWorld,
    pub config: Config,
    pub actuators: Vec<Actuator>,
    pub arms: Vec<Arm>,
    pub torso: RigidBodyHandle,
    pub yaw: RigidBodyHandle,
    pub fixed: RigidBodyHandle,
    pub objects: Vec<RigidBodyHandle>,
    pub table: ColliderHandle,
    pub ticks: u64,
}
fn body_handle_id(h: RigidBodyHandle) -> u32 {
    h.into_raw_parts().0
}
fn collider_id(h: ColliderHandle) -> u32 {
    h.into_raw_parts().0
}
fn primitive(p: &Primitive) -> ColliderBuilder {
    ColliderBuilder::new(p.shape.shared())
        .position(Pose::from_parts(p.position.vector(), p.rotation.rotation()))
}
fn body(
    world: &mut PhysicsWorld,
    mass: &Inertial,
    position: Vector,
    r: Rotation,
) -> RigidBodyHandle {
    world.bodies.insert(
        RigidBodyBuilder::dynamic()
            .pose(Pose::from_parts(position, r))
            .additional_mass_properties(mass.properties())
            .can_sleep(false)
            .ccd_enabled(true),
    )
}
impl World {
    pub fn new(config: Config) -> Self {
        let mut physics = PhysicsWorld::new();
        let e = &config.environment;
        let r = &e.robot;
        let layout = &config.layout;
        physics.gravity = Vector::new(0., -9.81, 0.);
        physics.integration_parameters.dt = (1. / e.physics_hz) as f32;
        physics.integration_parameters.num_solver_iterations = e.solver.iterations;
        physics.integration_parameters.num_internal_pgs_iterations =
            e.solver.internal_pgs_iterations;
        physics
            .integration_parameters
            .normalized_prediction_distance = 0.002;
        physics
            .integration_parameters
            .contact_softness
            .natural_frequency = 120.;
        physics
            .integration_parameters
            .normalized_allowed_linear_error = 0.0001;
        let table = physics.colliders.insert(
            ColliderBuilder::cuboid(
                e.table_size / 2.,
                e.table_thickness / 2.,
                e.table_depth / 2.,
            )
            .translation(Vector::new(0., e.table_top - e.table_thickness / 2., 0.))
            .friction(e.friction),
        );
        physics
            .colliders
            .insert(ColliderBuilder::cuboid(3., 0.05, 3.).translation(Vector::new(0., -0.05, 0.)));
        for p in &layout.table {
            physics.colliders.insert(primitive(p).friction(e.friction));
        }
        let pivot = layout.pivot.vector();
        let fixed = physics
            .bodies
            .insert(RigidBodyBuilder::fixed().translation(pivot));
        let yaw = body(&mut physics, &r.inertials.yaw, pivot, Rotation::IDENTITY);
        physics.colliders.insert_with_parent(
            ColliderBuilder::ball(0.06).density(0.),
            yaw,
            &mut physics.bodies,
        );
        let torso = body(&mut physics, &r.inertials.torso, pivot, Rotation::IDENTITY);
        for p in &layout.mount {
            let parent = if p.position.y > layout.pivot.y {
                torso
            } else {
                fixed
            };
            physics.colliders.insert_with_parent(
                ColliderBuilder::new(p.shape.shared())
                    .position(Pose::from_parts(
                        p.position.vector() - pivot,
                        p.rotation.rotation(),
                    ))
                    .density(0.),
                parent,
                &mut physics.bodies,
            );
        }
        physics.bodies[yaw].recompute_mass_properties_from_colliders(&physics.colliders);
        physics.bodies[torso].recompute_mass_properties_from_colliders(&physics.colliders);
        let w = &r.body;
        let mut actuators = vec![
            Actuator::new(
                &mut physics,
                fixed,
                yaw,
                DVec3::ZERO,
                DVec3::Y,
                0.,
                [-w.yaw_limit, w.yaw_limit],
                w.motor.stiffness,
                w.motor.damping,
                w.motor.max_torque[0],
                w.speed,
                w.acceleration,
            ),
            Actuator::new(
                &mut physics,
                yaw,
                torso,
                DVec3::ZERO,
                DVec3::X,
                0.,
                [0., w.pitch_limit],
                w.motor.stiffness,
                w.motor.damping,
                w.motor.max_torque[1],
                w.speed,
                w.acceleration,
            ),
        ];
        let mut arms = Vec::new();
        for side in 0..2 {
            let frames = &layout.arms[side].frames;
            let group = wrist_groups(side);
            let mut bodies = Vec::new();
            for (i, frame) in frames.iter().enumerate() {
                let handle = body(
                    &mut physics,
                    &r.inertials.arms[i],
                    frame.position.vector(),
                    frame.rotation.rotation(),
                );
                let mut collider = primitive(&layout.links[i]).density(0.).friction(0.8);
                if i >= 3 {
                    collider = collider.collision_groups(group);
                }
                physics
                    .colliders
                    .insert_with_parent(collider, handle, &mut physics.bodies);
                physics.bodies[handle].recompute_mass_properties_from_colliders(&physics.colliders);
                bodies.push(handle);
            }
            for i in 0..6 {
                let parent = if i == 0 { torso } else { bodies[i - 1] };
                let anchor = if i == 0 {
                    layout.arms[side].base.double()
                        - double_vector(physics.bodies[torso].translation())
                } else {
                    DVec3::new(r.links[i - 1], 0., 0.)
                };
                actuators.push(Actuator::new(
                    &mut physics,
                    parent,
                    bodies[i],
                    anchor,
                    DVec3::from_array(r.axes[i]),
                    r.home_joints[i],
                    r.limits[i],
                    r.arm_motor.stiffness,
                    r.arm_motor.damping,
                    r.arm_motor.max_torque[i],
                    r.joint_speed,
                    r.joint_acceleration,
                ));
            }
            let mut fingers = Vec::new();
            let mut joints = Vec::new();
            for sign in [-1., 1.] {
                let anchor = DVec3::new(
                    r.links[5] + r.tool_length - r.finger_length / 2.,
                    0.,
                    sign * (r.home.gap + r.finger_width) / 2.,
                );
                let p = frames[5].rotation.double() * anchor + frames[5].position.double();
                let handle = body(
                    &mut physics,
                    &r.inertials.finger,
                    vector(p),
                    frames[5].rotation.rotation(),
                );
                physics.colliders.insert_with_parent(
                    ColliderBuilder::cuboid(
                        (r.finger_length / 2.) as f32,
                        (r.finger_depth / 2.) as f32,
                        (r.finger_width / 2.) as f32,
                    )
                    .density(0.)
                    .friction(1.),
                    handle,
                    &mut physics.bodies,
                );
                physics.bodies[handle].recompute_mass_properties_from_colliders(&physics.colliders);
                let mut limits = r.gap.map(|v| (sign * (v - r.home.gap) / 2.) as f32);
                limits.sort_by(f32::total_cmp);
                let joint = physics.impulse_joints.insert(
                    bodies[5],
                    handle,
                    PrismaticJointBuilder::new(Vector::Z)
                        .local_anchor1(vector(anchor))
                        .contacts_enabled(false)
                        .limits(limits)
                        .motor_model(MotorModel::ForceBased)
                        .motor_position(
                            0.,
                            r.finger_motor.stiffness as f32,
                            r.finger_motor.damping as f32,
                        )
                        .motor_max_force(r.finger_motor.max_force as f32),
                    true,
                );
                fingers.push(handle);
                joints.push(joint);
            }
            arms.push(Arm {
                bodies,
                fingers,
                joints,
                references: [0.; 2],
                velocities: [0.; 2],
                commanded_gap: r.home.gap,
                target_gap: r.home.gap,
            });
        }
        let mut objects = Vec::new();
        for o in &config.scene {
            let handle = physics.bodies.insert(
                RigidBodyBuilder::dynamic()
                    .pose(Pose::from_parts(o.position.vector(), o.rotation.rotation()))
                    .ccd_enabled(true),
            );
            physics.colliders.insert_with_parent(
                ColliderBuilder::new(o.shape.shared())
                    .mass((o.density * o.shape.volume()) as f32)
                    .friction(o.friction)
                    .restitution(0.08),
                handle,
                &mut physics.bodies,
            );
            physics.bodies[handle].recompute_mass_properties_from_colliders(&physics.colliders);
            objects.push(handle);
        }
        Self {
            physics,
            config,
            actuators,
            arms,
            torso,
            yaw,
            fixed,
            objects,
            table,
            ticks: 0,
        }
    }
    pub fn apply(&mut self, action: &[f64], continuous: bool) {
        for (i, a) in self.actuators.iter_mut().enumerate() {
            let at = if i < 8 { i } else { i + 1 };
            a.set_target(action[at], continuous);
        }
        self.arms[0].target_gap = action[8];
        self.arms[1].target_gap = action[15];
    }
    fn finger_states(&self, side: usize) -> Vec<FingerState> {
        let arm = &self.arms[side];
        let r = &self.config.environment.robot;
        let fm = &r.finger_motor;
        let palm = &self.physics.bodies[arm.bodies[5]];
        let q = double_rotation(palm.rotation());
        let axis = q * DVec3::Z;
        arm.fingers
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let finger = &self.physics.bodies[*h];
                let point = finger.translation();
                let position =
                    (q.conjugate() * (double_vector(point) - double_vector(palm.translation()))).z
                        - (if i == 0 { -1. } else { 1. }) * (r.home.gap + r.finger_width) / 2.;
                let velocity =
                    double_vector(finger.velocity_at_point(point) - palm.velocity_at_point(point))
                        .dot(axis);
                let requested = (fm.stiffness + fm.coupling_stiffness / 2.)
                    * (arm.references[i] - position)
                    + (fm.damping + fm.coupling_damping / 2.) * (arm.velocities[i] - velocity);
                FingerState {
                    position,
                    velocity,
                    reference: arm.references[i],
                    reference_velocity: arm.velocities[i],
                    requested_force_estimate: requested,
                    limited_force_estimate: requested.clamp(-fm.max_force, fm.max_force),
                }
            })
            .collect()
    }
    pub fn step(&mut self) {
        let dt = 1. / self.config.environment.physics_hz;
        let axis = double_rotation(self.physics.bodies[self.yaw].rotation()) * DVec3::X;
        let origin = double_vector(self.physics.bodies[self.torso].translation());
        let chain = std::iter::once(self.torso).chain(
            self.arms
                .iter()
                .flat_map(|a| a.bodies.iter().chain(&a.fingers).copied()),
        );
        let gravity = chain
            .map(|h| {
                let b = &self.physics.bodies[h];
                axis.dot(
                    (double_vector(b.center_of_mass()) - origin).cross(DVec3::new(
                        0.,
                        b.mass() as f64 * 9.81,
                        0.,
                    )),
                )
            })
            .sum();
        self.actuators[0].update(&mut self.physics, dt, 0.);
        self.actuators[1].update(&mut self.physics, dt, gravity);
        for side in 0..2 {
            let arm = &self.arms[side];
            let chain: Vec<_> = arm.bodies.iter().chain(&arm.fingers).copied().collect();
            for i in 0..6 {
                let a = &mut self.actuators[2 + side * 6 + i];
                let parent = &self.physics.bodies[a.parent];
                let axis = double_rotation(parent.rotation())
                    * DVec3::from_array(self.config.environment.robot.axes[i]);
                let origin = double_vector(self.physics.bodies[a.body].translation());
                let gravity = chain[i..]
                    .iter()
                    .map(|h| {
                        let b = &self.physics.bodies[*h];
                        axis.dot(
                            (double_vector(b.center_of_mass()) - origin).cross(DVec3::new(
                                0.,
                                b.mass() as f64 * 9.81,
                                0.,
                            )),
                        )
                    })
                    .sum();
                a.update(&mut self.physics, dt, gravity);
            }
            let measured = self.finger_states(side);
            let r = &self.config.environment.robot;
            let fm = &r.finger_motor;
            let k = fm.stiffness + fm.coupling_stiffness / 2.;
            let d = fm.damping + fm.coupling_damping / 2.;
            let arm = &mut self.arms[side];
            arm.commanded_gap +=
                (arm.target_gap - arm.commanded_gap).clamp(-r.speed.gap * dt, r.speed.gap * dt);
            for i in 0..2 {
                let other = &measured[1 - i];
                let target =
                    (if i == 0 { -1. } else { 1. }) * (arm.commanded_gap - r.home.gap) / 2.;
                arm.references[i] =
                    (fm.stiffness * target - fm.coupling_stiffness * other.position / 2.) / k;
                arm.velocities[i] = -fm.coupling_damping * other.velocity / (2. * d);
                self.physics
                    .impulse_joints
                    .get_mut(arm.joints[i], false)
                    .unwrap()
                    .data
                    .set_motor(
                        JointAxis::LinX,
                        arm.references[i] as f32,
                        arm.velocities[i] as f32,
                        k as f32,
                        d as f32,
                    );
            }
        }
        self.physics.step();
        self.ticks += 1;
    }
    pub fn metadata(&self) -> Value {
        let bodies:Vec<_>=self.physics.bodies.iter().map(|(h,b)| {
            let m=&b.mass_properties().local_mprops;
            json!({"id":body_handle_id(h),"dynamic":b.is_dynamic(),"colliders":b.colliders().iter().map(|h|collider_id(*h)).collect::<Vec<_>>(),"mass":b.mass() as f64,"localCom":V3::from(m.local_com),"principalInertia":V3::from(m.principal_inertia()),"inertiaFrame":Q4::from(m.principal_inertia_local_frame)})
        }).collect();
        let colliders:Vec<_>=self.physics.colliders.iter().map(|(h,c)| {
            let shape=if let Some(s)=c.shape().as_cuboid() {Shape::Cuboid{size:[s.half_extents.x as f64*2.,s.half_extents.y as f64*2.,s.half_extents.z as f64*2.]}}
            else if let Some(s)=c.shape().as_ball() {Shape::Sphere{radius:s.radius as f64}}
            else {let s=c.shape().as_cylinder().unwrap();Shape::Cylinder{height:s.half_height as f64*2.,radius:s.radius as f64}};
            json!({"id":collider_id(h),"shape":shape,"collisionGroups":(c.collision_groups().memberships.bits()<<16)|c.collision_groups().filter.bits()})
        }).collect();
        json!({"bodies":bodies,"colliders":colliders,"table":collider_id(self.table),"objects":self.objects.iter().map(|h|body_handle_id(*h)).collect::<Vec<_>>(),"torso":body_handle_id(self.torso),"fixed":body_handle_id(self.fixed),"arms":self.arms.iter().map(|a|json!({"bodies":a.bodies.iter().map(|h|body_handle_id(*h)).collect::<Vec<_>>(),"fingers":a.fingers.iter().map(|h|body_handle_id(*h)).collect::<Vec<_>>()})).collect::<Vec<_>>(),"impulseJoints":self.physics.impulse_joints.len()})
    }
    pub fn write_frame(&mut self, values: &mut Vec<f64>) {
        values.clear();
        values.extend_from_slice(&[
            self.ticks as f64,
            self.physics.bodies.len() as f64,
            self.physics.colliders.len() as f64,
            self.objects.len() as f64,
        ]);
        let poses = [self.pose_values(0), self.pose_values(1)];
        let mut target = [0.; 16];
        for (actuator, target) in self.actuators[..2].iter_mut().zip(&mut target[..2]) {
            values.push(actuator.angle(&self.physics));
            *target = actuator.target;
        }
        for side in 0..2 {
            for i in 0..6 {
                let at = 2 + side * 6 + i;
                values.push(self.actuators[at].angle(&self.physics));
                target[2 + side * 7 + i] = self.actuators[at].target;
            }
            values.push(poses[side][3]);
            target[8 + side * 7] = self.arms[side].target_gap;
        }
        values.extend_from_slice(&target);
        for (h, body) in self.physics.bodies.iter() {
            values.push(body_handle_id(h) as f64);
            values.extend(body.translation().to_array().map(f64::from));
            let q = Q4::from(body.rotation());
            values.extend_from_slice(&[q.x, q.y, q.z, q.w]);
            values.extend(body.linvel().to_array().map(f64::from));
            values.extend(body.angvel().to_array().map(f64::from));
            values.extend(body.center_of_mass().to_array().map(f64::from));
        }
        for (h, collider) in self.physics.colliders.iter() {
            values.push(collider_id(h) as f64);
            values.extend(collider.translation().to_array().map(f64::from));
            let q = Q4::from(collider.rotation());
            values.extend_from_slice(&[q.x, q.y, q.z, q.w]);
        }
        for pose in poses {
            values.extend_from_slice(&pose);
        }
        for actuator in &mut self.actuators {
            values.extend_from_slice(&actuator.diagnostic_values(&self.physics));
        }
        for side in 0..2 {
            for f in self.finger_states(side) {
                values.extend_from_slice(&[
                    f.position,
                    f.velocity,
                    f.reference,
                    f.reference_velocity,
                    f.requested_force_estimate,
                    f.limited_force_estimate,
                ]);
            }
        }
        for arm in &self.arms {
            for object in &self.objects {
                for finger in &arm.fingers {
                    values.extend_from_slice(&contact_values(&self.physics, *finger, *object));
                }
            }
        }
        let pair_count = values.len();
        values.push(0.);
        for pair in self.physics.narrow_phase.contact_pairs() {
            // Narrow-phase candidates retain cached points after the solver releases contact.
            if !pair.has_any_active_contact() {
                continue;
            }
            values[pair_count] += 1.;
            values.extend_from_slice(&[
                collider_id(pair.collider1) as f64,
                collider_id(pair.collider2) as f64,
                pair.manifolds().len() as f64,
            ]);
            let collider1 = &self.physics.colliders[pair.collider1];
            let collider2 = &self.physics.colliders[pair.collider2];
            for m in pair.manifolds() {
                let pose1 = m.subshape_pos1().prepend_to(collider1.position());
                let pose2 = m.subshape_pos2().prepend_to(collider2.position());
                let normal = pose1.rotation * m.local_n1;
                values.extend(normal.to_array().map(f64::from));
                values.extend_from_slice(&[m.data.friction as f64, m.points.len() as f64]);
                for point in &m.points {
                    // Contact recycling leaves `dist` stale; project the retained anchors at this tick.
                    let separation = (pose2.transform_point(point.local_p2)
                        - pose1.transform_point(point.local_p1))
                    .dot(normal);
                    values.extend_from_slice(&[separation as f64, point.data.impulse as f64]);
                    values.extend(point.local_p1.to_array().map(f64::from));
                    values.extend(point.local_p2.to_array().map(f64::from));
                }
            }
        }
    }
    fn pose_values(&self, side: usize) -> [f64; 8] {
        let arm = &self.arms[side];
        let r = &self.config.environment.robot;
        let palm = &self.physics.bodies[arm.bodies[5]];
        let a = &self.physics.bodies[arm.fingers[0]];
        let b = &self.physics.bodies[arm.fingers[1]];
        let tip = |body: &RigidBody| {
            double_rotation(body.rotation()) * DVec3::new(r.finger_length / 2., 0., 0.)
                + double_vector(body.translation())
        };
        let p = (tip(a) + tip(b)) / 2.;
        let q = double_rotation(palm.rotation());
        let gap = (q.conjugate()
            * (double_vector(b.translation()) - double_vector(a.translation())))
        .z - r.finger_width;
        {
            let q = Q4::from(palm.rotation());
            [p.x, p.y, p.z, gap, q.x, q.y, q.z, q.w]
        }
    }
}
pub fn contact_values(
    physics: &PhysicsWorld,
    finger: RigidBodyHandle,
    object: RigidBodyHandle,
) -> [f64; 5] {
    let f = &physics.bodies[finger];
    let o = &physics.bodies[object];
    let fh = f.colliders()[0];
    let oh = o.colliders()[0];
    let collider = &physics.colliders[fh];
    let mut force = 0.;
    let mut friction = 0.;
    let mut slip = 0.;
    let mut points = 0;
    if let Some(pair) = physics.narrow_phase.contact_pair(fh, oh) {
        for m in pair.manifolds() {
            let normal = double_vector(m.data.normal);
            let mu = m.data.friction as f64;
            for c in &m.points {
                let impulse = c.data.impulse as f64;
                if impulse <= 0. {
                    continue;
                }
                let local = if pair.collider1 == fh {
                    c.local_p1
                } else {
                    c.local_p2
                };
                let point = collider.position().transform_point(local);
                let relative =
                    double_vector(o.velocity_at_point(point) - f.velocity_at_point(point));
                let tangential = relative - normal * relative.dot(normal);
                force += impulse;
                friction += impulse * mu;
                slip += impulse * tangential.length();
                points += 1;
            }
        }
    }
    let dt = physics.integration_parameters.dt as f64;
    [
        force / dt,
        friction / dt,
        if force > 0. { slip / force } else { 0. },
        if force > 0. { friction / force } else { 0. },
        points as f64,
    ]
}

#[cfg(test)]
pub fn contact_feedback(
    physics: &PhysicsWorld,
    finger: RigidBodyHandle,
    object: RigidBodyHandle,
) -> Value {
    let v = contact_values(physics, finger, object);
    json!({"normalForce":v[0],"frictionLimit":v[1],"slipSpeed":v[2],"friction":v[3],"points":v[4]})
}

fn wrist_groups(side: usize) -> InteractionGroups {
    let membership = 1u32 << (14 + side);
    InteractionGroups::new(
        Group::from_bits_retain(membership),
        Group::from_bits_retain(0xffff ^ membership),
        InteractionTestMode::And,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opposite_wrists_collide_and_same_wrist_internal_parts_do_not() {
        for same_arm in [true, false] {
            let mut world = PhysicsWorld::new();
            world.gravity = Vector::ZERO;
            let mut colliders = Vec::new();
            for side in 0..2 {
                let b = world
                    .bodies
                    .insert(RigidBodyBuilder::dynamic().translation(Vector::new(
                        side as f32 * 0.05,
                        0.,
                        0.,
                    )));
                colliders.push(
                    world.colliders.insert_with_parent(
                        ColliderBuilder::cuboid(0.03, 0.03, 0.03)
                            .collision_groups(wrist_groups(if same_arm { 0 } else { side })),
                        b,
                        &mut world.bodies,
                    ),
                );
            }
            world.step();
            let contacts = world
                .narrow_phase
                .contact_pair(colliders[0], colliders[1])
                .map_or(0, |p| p.manifolds().iter().map(|m| m.points.len()).sum());
            assert_eq!(contacts > 0, !same_arm);
        }
    }
    #[test]
    fn contact_feedback_recovers_support_force_friction_and_physical_slip() {
        let mut world = PhysicsWorld::new();
        world.gravity = Vector::new(0., -9.81, 0.);
        world.integration_parameters.dt = 1. / 120.;
        let support = world.bodies.insert(RigidBodyBuilder::fixed());
        world.colliders.insert_with_parent(
            ColliderBuilder::cuboid(2., 0.05, 2.).friction(0.8),
            support,
            &mut world.bodies,
        );
        let object = world.bodies.insert(
            RigidBodyBuilder::dynamic()
                .translation(Vector::new(0., 0.1, 0.))
                .can_sleep(false),
        );
        world.colliders.insert_with_parent(
            ColliderBuilder::cuboid(0.05, 0.05, 0.05)
                .mass(1.)
                .friction(0.8),
            object,
            &mut world.bodies,
        );
        world.bodies[object].add_force(Vector::new(2., 0., 0.), true);
        for _ in 0..240 {
            world.step();
        }
        let held = contact_feedback(&world, support, object);
        assert!((held["normalForce"].as_f64().unwrap() - 9.81).abs() < 0.05);
        assert!((held["frictionLimit"].as_f64().unwrap() - 9.81 * 0.8).abs() < 0.05);
        assert!(held["slipSpeed"].as_f64().unwrap() < 0.001);
        assert!((held["friction"].as_f64().unwrap() - 0.8).abs() < 1e-6);
        world.bodies[object].reset_forces(false);
        world.bodies[object].add_force(Vector::new(20., 0., 0.), true);
        for _ in 0..12 {
            world.step();
        }
        assert!(
            contact_feedback(&world, support, object)["slipSpeed"]
                .as_f64()
                .unwrap()
                > 0.1
        );
        assert_eq!(
            contact_feedback(&world, object, support)["normalForce"],
            contact_feedback(&world, support, object)["normalForce"]
        );
    }
}
