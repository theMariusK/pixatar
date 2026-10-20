# pixatar

## Bending controls

Hold **Q** and select an element, Bolt/Orbit, and an action. Bolt/Orbit controls how
you gather material; the outer ring chooses your **right mouse button** ability.
Hold **LMB** to gather, and use **RMB** while keeping your material held.

## Attack control

| Control | Effect |
| --- | --- |
| Shift | Charge held material; full charge takes 1.25 seconds and increases attack speed and force. |
| Mouse wheel | Adjust how much material you gather. Reducing size releases the excess; increasing it requires gathering more with LMB. |
| C | Toggle holding material after releasing LMB. This also keeps it held while choosing an action in Q. |
| V | Recall your airborne material to your hand, then use LMB to control it again. |

Gather, charge, and release LMB for an aimed throw, or press RMB for the selected
Punch or ability. Charging also strengthens Whip, Wall, Spikes, Dash, and Vortex;
guards and Flamethrower retain their normal behavior. The HUD shows size, charge,
and hold/recall status. Opening Q clears charge.

Recall reaches 285 pixels and requires a clear path through terrain. It only
returns your surviving airborne material, including thrown rocks and fireballs;
settled earth, spent attacks, and material used by active abilities cannot be
recovered. Returning material causes no contact damage, and fire/air keep aging.
Water and earth are preserved when resizing or recalling. **F** still toggles
fullscreen.

## Element abilities

| Element | Ability | Controls and effect |
| --- | --- | --- |
| Fire | Flamethrower | Hold RMB for a stream of fire from your hand; lasts up to 2.5 seconds. |
| Water | Whip | Gather at least 6 drops, then press RMB to lash, drench, and pull a target. |
| Water | Shield | Gather at least 8 drops, then hold RMB for a shield facing the mouse. Incoming fire spends water; release lets surviving drops fall. |
| Earth | Wall | Gather at least 9 cells, aim at ground, and press RMB to raise cover. |
| Earth | Spikes | Gather at least 12 cells, aim at ground, and press RMB to raise spikes that strike and lift targets. |
| Earth | Catch | Aim toward an incoming rock and hold RMB. Captured earth stays held; release RMB and press again to throw it back. |
| Air | Dash | Gather at least 8 wisps, then press RMB to dash toward the mouse. |
| Air | Vortex | Gather at least 12 wisps, then press RMB to create a pulling, swirling current; hold RMB to steer it. |
| Air | Deflect | Gather at least 8 wisps, aim toward incoming attacks, and hold RMB to redirect them. Each interception spends air. |

Cooldowns and missing-resource hints appear in the HUD. Water and earth abilities
use gathered material, and attacks retain their element interactions with fire,
water, wind, rocks, and terrain.

## Defensive bending

Select **Earth + Catch**, **Water + Shield**, or **Air + Deflect** in Q. Guards face
the mouse and stop approaching attacks in front of you. Start a guard just before
impact for a stronger block during its first 0.22 seconds. Terrain blocks guards;
attacks from behind can get through.

Catch works without gathering earth first. Capacity and impact energy limit the
rocks you can catch, and LMB resumes normal control of captured material. Shield
turns fire into steam and spends more water on stronger attacks; insufficient water
weakens a fireball. Deflect redirects bolts, fireballs, rocks, debris, and airborne
fire/water particles, disabling homing on reflected bolts. Unused air is released
when you lower the guard. The HUD shows remaining guard resources and timing bonuses.

Defenses handle locally simulated attacks and falling terrain. Remote spell visuals
use the game's existing multiplayer collision authority.

## Impact feedback

Hits on bodies show a brief directional mark. Terrain and object contacts produce
water splashes, heavy earth chips and dust, fire embers, or wind streaks, with
element-specific sounds. Larger and charged attacks produce stronger cues; decisive
hits add a short camera jolt and pause. Fireballs leave a brief glow at impact,
while extinguished fire produces steam.

Successful guards show a curved block mark; timed blocks add a second bright arc
and a sharper sound. Repeated contacts are throttled, and camera cues share a
cooldown so sustained attacks stay readable. Offscreen contacts do not shake the
camera.
