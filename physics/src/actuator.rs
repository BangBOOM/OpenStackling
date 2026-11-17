use crate::config::{Q4, V3};
use glam::{DQuat, DVec3};
use rapier3d::prelude::*;

pub struct Actuator {
    pub joint: ImpulseJointHandle,
    pub parent: RigidBodyHandle,
    pub body: RigidBodyHandle,
    axis: DVec3,
    frame: DQuat,
    rotation: DQuat,
    measured: f64,
    position: f64,
    velocity: f64,
    target_age: f64,
    target_interval: f64,
    target_velocity: f64,
    continuous: bool,
    gravity: f64,
    pub target: f64,
    limits: [f64; 2],
    stiffness: f64,
    damping: f64,
    cap: f64,
    speed: f64,
    acceleration: f64,
}

pub fn double_rotation(q: &Rotation) -> DQuat {
    Q4::from(*q).double()
}
pub fn double_vector(v: Vector) -> DVec3 {
    V3::from(v).double()
}
pub fn rotation(q: DQuat) -> Rotation {
    Rotation::from_xyzw(q.x as f32, q.y as f32, q.z as f32, q.w as f32)
}
pub fn vector(v: DVec3) -> Vector {
    Vector::new(v.x as f32, v.y as f32, v.z as f32)
}
fn f32_round(v: f64) -> f64 {
    v as f32 as f64
}

impl Actuator {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        world: &mut PhysicsWorld,
        parent: RigidBodyHandle,
        body: RigidBodyHandle,
        anchor: DVec3,
        axis: DVec3,
        initial: f64,
        limits: [f64; 2],
        stiffness: f64,
        damping: f64,
        cap: f64,
        speed: f64,
        acceleration: f64,
    ) -> Self {
        let joint = world.impulse_joints.insert(
            parent,
            body,
            RevoluteJointBuilder::new(vector(axis))
                .local_anchor1(vector(anchor))
                .contacts_enabled(false)
                .motor_model(MotorModel::ForceBased)
                .motor_max_force(cap as f32),
            true,
        );
        let frame = double_rotation(
            &world
                .impulse_joints
                .get(joint)
                .unwrap()
                .data
                .local_frame1
                .rotation,
        );
        let mut actuator = Self {
            joint,
            parent,
            body,
            axis,
            frame,
            rotation: DQuat::IDENTITY,
            measured: initial,
            position: f32_round(initial),
            velocity: 0.,
            target_age: 0.,
            target_interval: 0.,
            target_velocity: 0.,
            continuous: false,
            gravity: 0.,
            target: initial,
            limits,
            stiffness,
            damping,
            cap,
            speed,
            acceleration,
        };
        actuator.angle(world);
        actuator.configure(world, 0.);
        actuator
    }
    pub fn angle(&mut self, world: &PhysicsWorld) -> f64 {
        let relative = double_rotation(world.bodies[self.parent].rotation()).conjugate()
            * double_rotation(world.bodies[self.body].rotation());
        let twist = relative.xyz().dot(self.axis);
        self.rotation = DQuat::from_xyzw(
            self.axis.x * twist,
            self.axis.y * twist,
            self.axis.z * twist,
            relative.w,
        )
        .normalize();
        let raw = 2. * twist.atan2(relative.w);
        self.measured = raw
            + std::f64::consts::TAU * ((self.measured - raw) / std::f64::consts::TAU + 0.5).floor();
        self.measured
    }
    pub fn set_target(&mut self, value: f64, continuous: bool) {
        self.target_velocity = if continuous && self.continuous && self.target_age > 0. {
            ((f32_round(value) - f32_round(self.target)) / self.target_age)
                .clamp(-self.speed, self.speed)
        } else {
            0.
        };
        self.target_interval = self.target_age;
        self.target_age = 0.;
        self.target = value;
        self.continuous = continuous;
    }
    pub fn update(&mut self, world: &mut PhysicsWorld, dt: f64, gravity: f64) {
        self.gravity = gravity;
        let remaining = f32_round(self.target) - self.position;
        let desired = remaining.signum()
            * self
                .speed
                .min((2. * self.acceleration * remaining.abs()).sqrt());
        let feedforward = if self.target_age < self.target_interval {
            self.target_velocity
        } else {
            0.
        };
        let change = if self.continuous {
            (feedforward + 2.5 * remaining).clamp(-self.speed, self.speed) - self.velocity
        } else {
            desired - self.velocity
        };
        self.velocity = (self.velocity
            + change.clamp(-self.acceleration * dt, self.acceleration * dt))
        .clamp(-self.speed, self.speed);
        let step = self.velocity * dt;
        if !self.continuous && step.abs() >= remaining.abs() && step * remaining >= 0. {
            self.position = f32_round(self.target);
            self.velocity = 0.;
        } else {
            let next = self.position + step;
            self.position = next.clamp(self.limits[0], self.limits[1]);
            if next != self.position {
                self.velocity = 0.;
            }
        }
        self.angle(world);
        self.configure(world, gravity);
        self.target_age += dt;
    }
    fn configure(&self, world: &mut PhysicsWorld, gravity: f64) {
        let window = std::f64::consts::FRAC_PI_2;
        let measured = f32_round(self.measured);
        let data = &mut world
            .impulse_joints
            .get_mut(self.joint, false)
            .unwrap()
            .data;
        data.local_frame1.rotation = rotation(self.rotation * self.frame);
        data.set_limits(
            JointAxis::AngX,
            [
                (self.limits[0] - measured).clamp(-window, window) as f32,
                (self.limits[1] - measured).clamp(-window, window) as f32,
            ],
        );
        data.set_motor(
            JointAxis::AngX,
            (self.position - measured + gravity / self.stiffness).clamp(-window, window) as f32,
            self.velocity as f32,
            self.stiffness as f32,
            self.damping as f32,
        );
    }
    pub fn diagnostic_values(&mut self, world: &PhysicsWorld) -> [f64; 9] {
        let measured = self.angle(world);
        let parent = &world.bodies[self.parent];
        let body = &world.bodies[self.body];
        let axis = double_rotation(parent.rotation()) * self.axis;
        let velocity = (double_vector(body.angvel()) - double_vector(parent.angvel())).dot(axis);
        let error = self.position - f32_round(measured);
        let requested =
            self.stiffness * error + self.damping * (self.velocity - velocity) + self.gravity;
        let data = &world.impulse_joints.get(self.joint).unwrap().data;
        let anchor_error = double_vector(parent.position().transform_point(data.local_anchor1()))
            .distance(double_vector(
                body.position().transform_point(data.local_anchor2()),
            ));
        [
            self.position,
            self.velocity,
            velocity,
            self.gravity,
            requested,
            requested.clamp(-self.cap, self.cap),
            self.cap,
            error,
            anchor_error,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hinge(
        axis: DVec3,
        initial: f64,
        limits: [f64; 2],
        cap: f64,
    ) -> (PhysicsWorld, RigidBodyHandle, Actuator, DVec3) {
        let mut world = PhysicsWorld::new();
        world.gravity = Vector::ZERO;
        world.integration_parameters.dt = 1. / 120.;
        world.integration_parameters.num_solver_iterations = 24;
        world.integration_parameters.num_internal_pgs_iterations = 8;
        let q = DQuat::from_axis_angle(DVec3::ONE.normalize(), 0.4);
        let parent = world
            .bodies
            .insert(RigidBodyBuilder::fixed().pose(Pose::from_parts(Vector::ZERO, rotation(q))));
        let body = world.bodies.insert(
            RigidBodyBuilder::dynamic()
                .pose(Pose::from_parts(
                    Vector::ZERO,
                    rotation(q * DQuat::from_axis_angle(axis, initial)),
                ))
                .can_sleep(false),
        );
        world.colliders.insert_with_parent(
            ColliderBuilder::ball(0.2).mass(10.),
            body,
            &mut world.bodies,
        );
        world.bodies[body].recompute_mass_properties_from_colliders(&world.colliders);
        let actuator = Actuator::new(
            &mut world,
            parent,
            body,
            DVec3::ZERO,
            axis,
            initial,
            limits,
            12000.,
            160.,
            cap,
            1.2,
            2.5,
        );
        (world, body, actuator, q * axis)
    }
    #[test]
    fn feedback_and_gravity_share_one_physical_torque_cap() {
        for gravity in [-100f64, 100.] {
            let (mut world, body, mut a, axis) = hinge(DVec3::X, 0., [-2., 2.], 0.2);
            a.target = -gravity.signum();
            let mut previous = 0.;
            for _ in 0..120 {
                a.update(&mut world, 1. / 120., gravity);
                world.step();
                let speed = double_vector(world.bodies[body].angvel()).dot(axis);
                let torque = (speed - previous) * 0.16 * 120.;
                assert!(
                    torque.abs() <= 0.2001,
                    "Combined torque {torque} exceeds 0.2 Nm"
                );
                assert_eq!(world.bodies[body].user_torque(), Vector::ZERO);
                previous = speed;
            }
        }
    }
    #[test]
    fn multi_turn_limits_stop_external_torques_in_both_directions() {
        for limit in [4.2, std::f64::consts::TAU] {
            let (mut world, body, mut a, axis) = hinge(DVec3::Y, 0., [-limit, limit], 0.000001);
            for sign in [1., -1.] {
                let mut extreme = 0f64;
                for _ in 0..120 * 7 {
                    world.bodies[body].reset_torques(false);
                    world.bodies[body].add_torque(vector(axis * (sign * 0.5)), true);
                    a.update(&mut world, 1. / 120., 0.);
                    world.step();
                    extreme = extreme.max(a.angle(&world).abs());
                }
                assert!(
                    extreme <= limit + 0.005,
                    "Limit {limit} crossed at {extreme}"
                );
                assert!((a.angle(&world) - sign * limit).abs() < 0.005);
            }
        }
    }
    #[test]
    fn absolute_targets_retain_winding_on_all_axes() {
        for axis in [DVec3::X, DVec3::Y, DVec3::Z] {
            let (mut world, _, mut a, _) = hinge(
                axis,
                -std::f64::consts::PI,
                [-std::f64::consts::TAU, std::f64::consts::TAU],
                40.,
            );
            for target in [6., -6.] {
                a.target = target;
                for _ in 0..120 * 15 {
                    a.update(&mut world, 1. / 120., 0.);
                    world.step();
                }
                assert!((a.angle(&world) - target).abs() < 0.001);
            }
        }
    }
    #[test]
    fn continuous_velocity_expires_and_final_target_settles() {
        let (mut world, _, mut a, _) = hinge(
            DVec3::Z,
            0.,
            [-std::f64::consts::TAU, std::f64::consts::TAU],
            40.,
        );
        for tick in 0..120 {
            if tick % 6 == 0 {
                a.set_target(tick as f64 / 120. * 0.2, true);
            }
            a.update(&mut world, 1. / 120., 0.);
            world.step();
        }
        let target = a.target;
        for _ in 0..120 * 3 {
            a.update(&mut world, 1. / 120., 0.);
            world.step();
        }
        assert!((a.angle(&world) - target).abs() < 0.0001);
    }
}
