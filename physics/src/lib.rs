pub mod actuator;
pub mod config;
pub mod world;
use config::{Q4, Shape, V3};
use napi::{Error, Result};
use napi_derive::napi;
use rapier3d::prelude::*;
use serde::Deserialize;
use serde_json::Value;

fn parse<T: serde::de::DeserializeOwned>(json: &str) -> Result<T> {
    serde_json::from_str(json).map_err(|e| Error::from_reason(e.to_string()))
}
fn encode(value: Value) -> Result<String> {
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub struct NativeWorld {
    inner: Option<world::World>,
    frame_values: Vec<f64>,
}
#[napi]
impl NativeWorld {
    #[napi(constructor)]
    pub fn new(config: String) -> Result<Self> {
        Ok(Self {
            inner: Some(world::World::new(parse(&config)?)),
            frame_values: Vec::with_capacity(2048),
        })
    }
    #[napi]
    pub fn metadata(&self) -> Result<String> {
        encode(
            self.inner
                .as_ref()
                .ok_or_else(|| Error::from_reason("World is closed"))?
                .metadata(),
        )
    }
    #[napi]
    pub fn frame(&mut self, mut output: napi::bindgen_prelude::Float64Array) -> Result<u32> {
        self.inner
            .as_mut()
            .ok_or_else(|| Error::from_reason("World is closed"))?
            .write_frame(&mut self.frame_values);
        if output.len() >= self.frame_values.len() {
            // This synchronous call owns the output view for its duration and
            // does not re-enter JavaScript while writing it.
            let destination = unsafe { output.as_mut() };
            destination[..self.frame_values.len()].copy_from_slice(&self.frame_values);
        }
        Ok(self.frame_values.len() as u32)
    }
    #[napi]
    pub fn apply(&mut self, action: Vec<f64>, continuous: bool) -> Result<()> {
        if action.len() != 16 || action.iter().any(|v| !v.is_finite()) {
            return Err(Error::from_reason("Expected sixteen finite action targets"));
        }
        self.open()?.apply(&action, continuous);
        Ok(())
    }
    #[napi]
    pub fn step(&mut self, output: napi::bindgen_prelude::Float64Array) -> Result<u32> {
        self.open()?.step();
        self.frame(output)
    }
    #[napi]
    pub fn set_body(&mut self, command: String) -> Result<()> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Command {
            id: u32,
            position: Option<V3>,
            rotation: Option<Q4>,
            velocity: Option<V3>,
            angular_velocity: Option<V3>,
            impulse: Option<V3>,
            torque_impulse: Option<V3>,
            point: Option<V3>,
            gravity_scale: Option<f32>,
            additional_mass: Option<f32>,
            force: Option<V3>,
            torque: Option<V3>,
            #[serde(default)]
            reset_forces: bool,
            #[serde(default)]
            reset_torques: bool,
        }
        let c: Command = parse(&command)?;
        let world = self.open()?;
        let h = world
            .physics
            .bodies
            .iter()
            .find(|(h, _)| h.into_raw_parts().0 == c.id)
            .map(|(h, _)| h)
            .ok_or_else(|| Error::from_reason("Unknown body"))?;
        let body = &mut world.physics.bodies[h];
        if let Some(v) = c.position {
            body.set_translation(v.vector(), true);
        }
        if let Some(v) = c.rotation {
            body.set_rotation(v.rotation(), true);
        }
        if let Some(v) = c.velocity {
            body.set_linvel(v.vector(), true);
        }
        if let Some(v) = c.angular_velocity {
            body.set_angvel(v.vector(), true);
        }
        if let Some(v) = c.impulse {
            if let Some(p) = c.point {
                body.apply_impulse_at_point(v.vector(), p.vector(), true);
            } else {
                body.apply_impulse(v.vector(), true);
            }
        }
        if let Some(v) = c.torque_impulse {
            body.apply_torque_impulse(v.vector(), true);
        }
        if c.reset_forces {
            body.reset_forces(false);
        }
        if c.reset_torques {
            body.reset_torques(false);
        }
        if let Some(v) = c.force {
            body.add_force(v.vector(), true);
        }
        if let Some(v) = c.torque {
            body.add_torque(v.vector(), true);
        }
        if let Some(v) = c.additional_mass {
            body.set_additional_mass(v, true);
        }
        if let Some(v) = c.gravity_scale {
            body.set_gravity_scale(v, true);
        }
        world.physics.bodies[h].recompute_mass_properties_from_colliders(&world.physics.colliders);
        world
            .physics
            .bodies
            .propagate_modified_body_positions_to_colliders(&mut world.physics.colliders);
        Ok(())
    }
    #[napi]
    pub fn set_collider(&mut self, command: String) -> Result<()> {
        #[derive(Deserialize)]
        struct Command {
            id: u32,
            friction: f32,
        }
        let c: Command = parse(&command)?;
        let world = self.open()?;
        let h = world
            .physics
            .colliders
            .iter()
            .find(|(h, _)| h.into_raw_parts().0 == c.id)
            .map(|(h, _)| h)
            .ok_or_else(|| Error::from_reason("Unknown collider"))?;
        world.physics.colliders[h].set_friction(c.friction);
        Ok(())
    }
    #[napi]
    pub fn dispose(&mut self) {
        self.inner.take();
    }
    fn open(&mut self) -> Result<&mut world::World> {
        self.inner
            .as_mut()
            .ok_or_else(|| Error::from_reason("World is closed"))
    }
}

enum QueryShape {
    Cuboid(rapier3d::parry::shape::Cuboid),
    Cylinder(rapier3d::parry::shape::Cylinder),
    Ball(rapier3d::parry::shape::Ball),
}
impl QueryShape {
    fn read(values: &[f64]) -> Result<Self> {
        match values[0] {
            0. => Ok(Self::Cuboid(rapier3d::parry::shape::Cuboid::new(
                Vector::new(
                    (values[1] / 2.) as f32,
                    (values[2] / 2.) as f32,
                    (values[3] / 2.) as f32,
                ),
            ))),
            1. => Ok(Self::Cylinder(rapier3d::parry::shape::Cylinder::new(
                (values[1] / 2.) as f32,
                values[2] as f32,
            ))),
            2. => Ok(Self::Ball(rapier3d::parry::shape::Ball::new(
                values[1] as f32,
            ))),
            _ => Err(Error::from_reason("Unsupported query shape")),
        }
    }
    fn shape(&self) -> &dyn rapier3d::parry::shape::Shape {
        match self {
            Self::Cuboid(s) => s,
            Self::Cylinder(s) => s,
            Self::Ball(s) => s,
        }
    }
}

// Fixed-layout numeric queries avoid serializing geometry in the planner's hot loop.
#[napi]
pub fn shape_contact(values: napi::bindgen_prelude::Float64Array) -> Result<f64> {
    if values.len() != 23 || values.iter().any(|v| !v.is_finite()) {
        return Err(Error::from_reason("Expected 23 finite shape-query values"));
    }
    let a = QueryShape::read(&values[0..4])?;
    let b = QueryShape::read(&values[4..8])?;
    let pose = |at: usize| {
        Pose::from_parts(
            Vector::new(
                values[at] as f32,
                values[at + 1] as f32,
                values[at + 2] as f32,
            ),
            Rotation::from_xyzw(
                values[at + 3] as f32,
                values[at + 4] as f32,
                values[at + 5] as f32,
                values[at + 6] as f32,
            ),
        )
    };
    let hit = rapier3d::parry::query::contact(
        &pose(8),
        a.shape(),
        &pose(15),
        b.shape(),
        values[22] as f32,
    )
    .map_err(|e| Error::from_reason(format!("Unsupported shape query: {e:?}")))?;
    Ok(hit.map_or(f64::NAN, |c| c.dist as f64))
}

#[napi]
pub fn shape_contains(request: String) -> Result<bool> {
    #[derive(Deserialize)]
    struct Request {
        shape: Shape,
        position: V3,
        rotation: Q4,
        point: V3,
    }
    let r: Request = parse(&request)?;
    Ok(r.shape.shared().contains_point(
        &Pose::from_parts(r.position.vector(), r.rotation.rotation()),
        r.point.vector(),
    ))
}
