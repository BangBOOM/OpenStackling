use glam::{DQuat, DVec3};
use rapier3d::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct V3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}
impl V3 {
    pub fn vector(self) -> Vector {
        Vector::new(self.x as f32, self.y as f32, self.z as f32)
    }
    pub fn double(self) -> DVec3 {
        DVec3::new(self.x, self.y, self.z)
    }
}
impl From<Vector> for V3 {
    fn from(v: Vector) -> Self {
        Self {
            x: v.x as f64,
            y: v.y as f64,
            z: v.z as f64,
        }
    }
}
impl From<DVec3> for V3 {
    fn from(v: DVec3) -> Self {
        Self {
            x: v.x,
            y: v.y,
            z: v.z,
        }
    }
}
#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct Q4 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub w: f64,
}
impl Q4 {
    pub fn double(self) -> DQuat {
        DQuat::from_xyzw(self.x, self.y, self.z, self.w)
    }
    pub fn rotation(self) -> Rotation {
        Rotation::from_xyzw(self.x as f32, self.y as f32, self.z as f32, self.w as f32)
    }
}
impl From<Rotation> for Q4 {
    fn from(q: Rotation) -> Self {
        Self {
            x: q.x as f64,
            y: q.y as f64,
            z: q.z as f64,
            w: q.w as f64,
        }
    }
}
impl From<&Rotation> for Q4 {
    fn from(q: &Rotation) -> Self {
        Self::from(*q)
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inertial {
    pub mass: f32,
    pub center_of_mass: [f32; 3],
    pub principal_inertia: [f32; 3],
    pub inertia_frame: [f32; 4],
}
impl Inertial {
    pub fn properties(&self) -> MassProperties {
        MassProperties::with_principal_inertia_frame(
            Vector::from_array(self.center_of_mass),
            self.mass,
            Vector::from_array(self.principal_inertia),
            Rotation::from_xyzw(
                self.inertia_frame[0],
                self.inertia_frame[1],
                self.inertia_frame[2],
                self.inertia_frame[3],
            ),
        )
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Motor {
    pub stiffness: f64,
    pub damping: f64,
    pub max_torque: Vec<f64>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerMotor {
    pub stiffness: f64,
    pub damping: f64,
    pub max_force: f64,
    pub coupling_stiffness: f64,
    pub coupling_damping: f64,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waist {
    pub yaw_limit: f64,
    pub pitch_limit: f64,
    pub speed: f64,
    pub acceleration: f64,
    pub motor: Motor,
}
#[derive(Clone, Deserialize)]
pub struct Inertials {
    pub arms: Vec<Inertial>,
    pub finger: Inertial,
    pub yaw: Inertial,
    pub torso: Inertial,
}
#[derive(Clone, Deserialize)]
pub struct Home {
    pub gap: f64,
}
#[derive(Clone, Deserialize)]
pub struct Speed {
    pub gap: f64,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Robot {
    pub axes: Vec<[f64; 3]>,
    pub links: Vec<f64>,
    pub limits: Vec<[f64; 2]>,
    pub home_joints: Vec<f64>,
    pub joint_speed: f64,
    pub joint_acceleration: f64,
    pub arm_motor: Motor,
    pub finger_motor: FingerMotor,
    pub body: Waist,
    pub inertials: Inertials,
    pub home: Home,
    pub speed: Speed,
    pub gap: [f64; 2],
    pub finger_length: f64,
    pub finger_width: f64,
    pub finger_depth: f64,
    pub tool_length: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub physics_hz: f64,
    pub solver: Solver,
    pub table_size: f32,
    pub table_depth: f32,
    pub table_top: f32,
    pub table_thickness: f32,
    pub friction: f32,
    pub robot: Robot,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Solver {
    pub iterations: usize,
    pub internal_pgs_iterations: usize,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Shape {
    Cuboid { size: [f64; 3] },
    Cylinder { height: f64, radius: f64 },
    Sphere { radius: f64 },
}
impl Shape {
    pub fn shared(&self) -> SharedShape {
        match *self {
            Self::Cuboid { size } => SharedShape::cuboid(
                (size[0] / 2.) as f32,
                (size[1] / 2.) as f32,
                (size[2] / 2.) as f32,
            ),
            Self::Cylinder { height, radius } => {
                SharedShape::cylinder((height / 2.) as f32, radius as f32)
            }
            Self::Sphere { radius } => SharedShape::ball(radius as f32),
        }
    }
    pub fn volume(&self) -> f64 {
        match *self {
            Self::Cuboid { size } => size.iter().product(),
            Self::Cylinder { height, radius } => std::f64::consts::PI * radius * radius * height,
            Self::Sphere { radius } => 4. * std::f64::consts::PI * radius.powi(3) / 3.,
        }
    }
}
#[derive(Deserialize)]
pub struct Object {
    pub shape: Shape,
    pub position: V3,
    pub rotation: Q4,
    pub density: f64,
    pub friction: f32,
}
#[derive(Deserialize)]
pub struct Frame {
    pub position: V3,
    pub rotation: Q4,
}
#[derive(Deserialize)]
pub struct Primitive {
    pub shape: Shape,
    pub position: V3,
    pub rotation: Q4,
}
#[derive(Deserialize)]
pub struct ArmLayout {
    pub frames: Vec<Frame>,
    pub base: V3,
}
#[derive(Deserialize)]
pub struct Layout {
    pub pivot: V3,
    pub mount: Vec<Primitive>,
    pub table: Vec<Primitive>,
    pub links: Vec<Primitive>,
    pub arms: Vec<ArmLayout>,
}
#[derive(Deserialize)]
pub struct Config {
    pub environment: Environment,
    pub scene: Vec<Object>,
    pub layout: Layout,
}
