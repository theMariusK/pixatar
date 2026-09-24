# Spell Abilities

Design reference for the spell wheel. To build a spell, pick **Element + Form + Modifier** on the wheel: hold **Q** for the primary slot or **E** for the secondary slot, and release to lock it in. Cast with **left click** (primary) or **right click** (secondary).

6 elements × 8 forms × 8 modifiers = **384 spells**. Every one is listed below, and each has its own behaviour and name.

**Legend:** a name marked **\*** already exists in `spells.js` (`ABILITY_NAMES` / `SIGNATURES`). Every other entry is a design target.

**Status:**
- **Water follows the Matter Rule in code.** Every Water form and modifier draws real water, spends it, and puts it somewhere. The *base* behaviours listed for each Water form are built. The hand-authored twists in the Water tables (Skipping Droplet, Spring, Old Faithful and so on) are still design targets, except for the entries marked \*.
- **Earth is design only.** The code still raises stone out of nothing; see [Implementation notes](#implementation-notes-water--earth).

---

## Forms and modifiers at a glance

| Form | Shape |
|---|---|
| Bolt | a single projectile |
| Nova | a burst centred on the caster |
| Beam | a held ray (channelled) |
| Ground | a wave that runs along the terrain surface |
| Orbit | objects circling the caster |
| Trail | a projectile that leaves something along its path |
| Mine | a trap placed at the target |
| Homing | a projectile that seeks targets |

| Modifier | General meaning |
|---|---|
| Chain | jumps on to further targets or connected material |
| Split | divides into several |
| Pierce | passes through what would stop it |
| Delay | builds up, then resolves later |
| Volatile | random and chaotic |
| Absorb | reverses the spell: pulls, drains or collects |
| Amplify | bigger, and qualitatively stronger |
| Anchor | stays put and persists |

---

## The Matter Rule (Water and Earth)

> **Water and Earth never create matter. They move what the world already has.**

Fire, Lightning, Dark and Arcane are energy: they burn, shock, curse and erase. Water and Earth are *substances*. Every water cell a Water spell places, and every stone cell an Earth spell raises, was first taken from somewhere in the world. The place it came from is left emptier.

### 1. Conservation

- A Water or Earth spell may **move**, **transform** or **destroy** matter. It may never **create** it.
- Every cell placed is paid for with a cell removed: from the world, from the caster's reserve, or from the spell's own carried load.
- When a spell ends, whatever mass it still carries is **dropped where it is**: a globe bursts into a puddle, orbiting stones fall as rubble, a disarmed mine spills its store. Nothing quietly vanishes except through the transformations in section 3.

### 2. Sources

| Element | Draws from | Never draws from |
|---|---|---|
| **Water** | `WATER` (1 : 1), `ICE` (1 : 1), `PACKED_ICE` (1 : 1), `SNOW` (2 snow → 1 water) | acid, oil, lava, anything else |
| **Earth** | loose: `SAND`, `DIRT`, `GRASS` (taken as dirt) · hard: `STONE`, `SANDSTONE`, `COAL`, `GOLD`, `BRICK` | `BEDROCK`, `GLASS`, wood/timber, snow and ice (those are Water's) |

Hard earth is **slower to draw** than loose earth (see section 7). Stone has to be pried out; sand simply lifts.

### 3. Allowed transformations

These are the only ways Water or Earth may change what matter *is*.

| Transformation | Ratio | Where it shows up |
|---|---|---|
| water → ice / ice → water (thaw) | 1 : 1 | Ice Wall, Hail, Iceberg, Frost Spray; `ICE_LIFE` thaws it back |
| water → packed ice | 1 : 1 | Frozen Bridge (never thaws on its own) |
| snow → water | 2 : 1 | whenever snow is drawn |
| water → steam (lost) | 1 : 0 | dousing fire, Steam Burst, Volatile sprays. Boiling water off is how Water *spends* itself |
| sand → sandstone (settling) | 1 : 1 | any Earth *structure* built from sand, so walls don't pour away |
| loose earth → stone (compaction) | 2 : 1 | Fortify, Compaction, Tunnel Bore lining |
| stone → sand (crushing) | 1 : 1 | Gravel Shot, Grinding Ring, Water Cutter, Caltrops |

The world's own chemistry still applies. Water on lava makes stone, but that costs the water cell that did it.

**Dousing costs water.** Every fire cell put out consumes one water cell as steam. Every lava cell cooled to stone consumes one water cell. A Water mage who spends the fight putting out fires runs dry.

### 4. Where matter is drawn from

Each form belongs to one of three kinds of draw site.

| Draw site | Forms | Rule |
|---|---|---|
| **Caster** | Bolt, Homing, Orbit, Trail, Beam | The reserve is spent first. Any shortfall is pulled from sources within the draw radius of the caster and flies to your hands before launch. |
| **Site** | Ground walls, Mine spikes, pillars, ridges, springs | Taken from the ground or water *at the effect location*. The reserve is not used. A wall rises out of the trench it digs, and a spike leaves a hollow beneath it. |
| **Surroundings** | Nova | Uses the material around the caster directly. The nova *is* the local water or ground. *(Water's Nova is built as a caster draw, so reserve first, then the water around you. The only difference is that the reserve is used.)* |

Individual entries below say which site they use when it isn't obvious.

### 5. Draw order and footing

- **Surface first, nearest first.** Cells that touch open space are taken before buried ones, and near before far. A pool drains from the top down, and a hillside is scooped from its face rather than hollowed out invisibly.
- **Water needs an open path.** A water cell can only be drawn if there's a clear line (no solids) from it to the draw point. You can't pull a sealed underground pocket up through rock. Earth has no such limit, because it moves the ground itself.
- **Footing guard.** Caster-site draws never take the three cells directly under the caster's feet, so casting a bolt doesn't drop you into a pit. Site draws have no guard: raising a wall under yourself is a choice.
- **Structure matters.** Removed cells are real removals. The periodic support pass (`checkStructuralSupport`) will collapse whatever they were holding up, including houses, overhangs and your own bunker.

### 6. The reserve

Each player carries a small store of each substance, shown as two gauges beside the health bar.

| | Cap | Refills from |
|---|---|---|
| Water reserve | 300 cells | wading (`player.liquid === 'water'`), which drinks from the pool at 40 cells/s · Water + Absorb casts |
| Earth reserve | 240 cells | the dig tool (dug earth goes into the reserve instead of being deleted) · Earth + Absorb casts · catching Earth debris (Gravel Shield) |

- The reserve lets caster-site spells **launch instantly**. Only the shortfall adds a wind-up.
- The player starts with a full reserve (the canteen they start the game with). Campaign enemies carry their own reserve, also starting full, and never refill it. A Tidewisp gets a few casts from it, then depends on water being nearby.
- If an Absorb cast collects more than the reserve can hold, the overflow is **dropped at the caster's feet**.
- The reserve belongs to the client, like health. In multiplayer it's never sent over the network, only the cells it changes.

### 7. Cost, wind-up, scaling, fizzle

Starting values; tune in play.

| Form | Water cost | Earth cost |
|---|---|---|
| Bolt | 40 | 30 |
| Nova | 120 | 100 |
| Beam | 30 / s | 25 / s |
| Ground | 150 | 120 |
| Orbit | 60 | 60 |
| Trail | 60, the bolt's load (1 per cell laid) | 5 per cell laid |
| Mine | 60, paid on placement | 50, paid on placement |
| Homing | 40 | 30 |

| Modifier | Cost effect |
|---|---|
| Split | ×1.2, divided between the pieces |
| Pierce | ×0.8 (a compressed, dense slug) |
| Amplify | ×2.5 |
| Chain | ×1; the mass is shared out along the jumps |
| Delay | ×1; some Delay spells keep gathering during the delay |
| Absorb | 0; it collects instead of spending |
| Volatile | ×1; the chaos spends mass as it goes |
| Anchor | depends on the entry |

- **Draw radius:** Water 28 cells, Earth 22 cells.
- **Draw speed:** water 400 cells/s · loose earth 300 cells/s · hard earth 120 cells/s. The wind-up is how long the shortfall takes to arrive, capped at 0.5s. Drawing from a stone cliff is visibly slower than scooping a dune.
- **Scaling:** if the spell gathers **G** of its cost **C**, it resolves at power `G / C`. Area and radius scale by `sqrt(G / C)` so the area tracks mass, and knockback scales linearly.
- **Fizzle:** below **25%** of cost the spell fails. The part taken from the reserve is refunded, since it never left your hands. What was already pulled out of the world drops at your feet (a dribble, a trickle of grit). The element's gauge flashes and the HUD says why (`No water in reach (needs 40)`).

### 8. Readability

- Each Water slot's HUD line shows its cost and what you can pay with, e.g. `· water 300, have 180+62`: reserve + water within reach, counting only water with an open path to you. A sealed underground lake doesn't count.
- *(Not built yet: shimmering the source cells a spell would draw.)*
- Gathered mass always travels visibly: water flows as droplet streams and earth flies as debris chunks (the existing debris system, as Telekinesis uses). The player should always be able to see where a spell's matter came from.

### 9. What this does to the game

- **The map is your mana.** Water is strong by lakes, in the rain it makes, and in the tundra (snow and packed ice). Earth is strong in deserts and on plains, weak on wooden structures and in open air.
- **Counterplay is terrain.** Starve a Water mage by draining the pool (Receding Tide, Drought), or by making them waste water on fires. Pull an Earth mage onto timber floors or into the sky.
- **Every Earth cast leaves a scar**: a pit, a trench, an undermined wall. Fortifying a hill digs a moat. Build a bunker carelessly and it collapses on you.
- **Water moves around, it doesn't pile up.** Rain Dance lifts pools and drops them elsewhere, and Flash Flood fills basins until it runs out. The total amount of water in a room only goes down, as steam.

---

## 🔥 Fire

### Bolt
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Wildfire\*** | On impact, fire spreads through every connected flammable cell, with no limit on jumps. |
| Split | **Ember Scatter** | Three fireballs fan out. Each leaves a small burning crater. |
| Pierce | **Magma Lance** | Melts straight through stone and leaves a lava-lined tunnel. |
| Delay | **Slow Fuse** | Sticks in terrain, glows for 2s, then erupts at twice the normal radius. |
| Volatile | **Sputtering Comet** | Wobbles in flight, drops embers, and detonates at a random point along its path. |
| Absorb | **Heat Sink** | Turns nearby fire to smoke and banks it. Your next Fire cast is bigger. |
| Amplify | **Meteor** | A huge, slow fireball that arcs under gravity. Sand at the crater rim fuses into glass. |
| Anchor | **Brazier** | Sticks where it lands and burns for 10s, igniting anything flammable nearby. |

### Nova
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Chain Reaction** | The burst sets off nearby gas and oil pockets, each exploding as its own nova. |
| Split | **Trinity Burst** | Three small novas go off on a triangle around you. |
| Pierce | **Core Heat** | The heat passes through walls. It burns enemies behind cover but leaves terrain alone. |
| Delay | **Kindling** | You glow for 1.5s and anyone touching you catches fire. Then you detonate. |
| Volatile | **Firecracker** | A dozen tiny pops at random spots around you over one second. |
| Absorb | **Backdraft** | Pulls in all nearby fire and lava. Lava becomes stone, and you heal for each cell absorbed. |
| Amplify | **Supernova** | A huge burst. Stone at the centre melts to lava and sand fuses into glass. |
| Anchor | **Pyre** | Leaves a burning pillar at the cast point that pulses flame every 0.5s. |

### Beam
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Arc Torch** | The jet jumps from its target to the nearest flammable cell or enemy, and keeps chaining. |
| Split | **Trident Flame** | Three narrow jets at spread angles. |
| Pierce | **Cutting Torch** | A white-hot line that cuts through supports, so stone drops as debris instead of burning. |
| Delay | **Heat Ray** | Shows an aim line for 1s, then scorches along it all at once. |
| Volatile | **Dragon's Breath** | A flamethrower that throws out random burning globs. |
| Absorb | **Heat Siphon** | Pulls fire and lava along the beam into you. Lava cools to stone. |
| Amplify | **Solar Lance** | A wide, long beam that melts everything except bedrock into lava. |
| Anchor | **Flame Turret** | Plants a nozzle that sprays fire in the aimed direction on its own for 6s. |

### Ground
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Grassfire** | Follows grass and leaves instead of terrain, jumping between patches. |
| Split | **Forked Blaze** | Two waves go out, one in each direction. |
| Pierce | **Magma Vein** | Travels underground and bursts up as lava geysers at intervals. |
| Delay | **Smoldering Line** | Chars its path invisibly, then the whole line bursts into flame at once. |
| Volatile | **Firestorm** | Throws random fire columns out to either side. |
| Absorb | **Firebreak** | Eats fire and flammable material, leaving a burnt strip that won't burn again. |
| Amplify | **Lava Surge** | A wave of flowing lava instead of flame. |
| Anchor | **Fire Wall\*** | Plants itself as a wall of flame that stays up. |

### Orbit
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Ember Relay** | Embers jump from you to enemies that get close, then return. |
| Split | **Twin Suns** | Two large fireballs orbit in opposite directions. |
| Pierce | **Blazing Halo** | Embers pass through terrain and carve a burning ring into walls as you move. |
| Delay | **Orbital Grenades** | Embers circle for 3s, then fly outward and explode. |
| Volatile | **Solar Flares** | Embers randomly break orbit and shoot off. |
| Absorb | **Flame Eater** | Eats incoming fire projectiles and fire cells, and grows with each one. |
| Amplify | **Inferno Mantle** | A close-range aura that burns what it touches. You can't be set on fire while it lasts. |
| Anchor | **Fire Totem** | The embers circle a fixed point instead of you. |

### Trail
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Fuse Line** | Lays a line of oil. When the bolt lands, flame races back along it. |
| Split | **Ember Rain** | Drops burning embers along the whole flight path. |
| Pierce | **Scorched Tunnel** | Bores through terrain and leaves the tunnel burning. |
| Delay | **Powder Trail** | Leaves gas behind that ignites 2s later as one long explosion. |
| Volatile | **Sparkler** | Sprays sparks in random directions as it flies. |
| Absorb | **Cooling Wake** | Cools everything it passes. Lava becomes stone and fire becomes smoke. |
| Amplify | **Comet Tail** | A big bolt with a long fire trail that hurts anyone who crosses it. |
| Anchor | **Hanging Flames** | The fire trail stays in the air for 8s as a barrier. |

### Mine
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Daisy Chain** | Triggering it sets off a line of four spaced mines. |
| Split | **Cluster Mine** | Bursts into several bouncing fire bomblets. |
| Pierce | **Buried Charge** | Sits hidden underground and blasts upward through the terrain. |
| Delay | **Timebomb** | Has no trigger. It explodes after a visible 5s countdown. |
| Volatile | **Unstable Charge** | Might go off early, or at double size. |
| Absorb | **Smoke Trap** | Puts out fire and fills the area with thick smoke that blocks vision. |
| Amplify | **Napalm Mine** | Sprays burning oil over a wide area. |
| Anchor | **Flame Vent** | Rearms itself and shoots up a fire column every time someone steps on it. |

### Homing
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Hellhound** | After a hit, it goes for the next nearest target, up to three. |
| Split | **Ember Swarm** | Five small homing embers. |
| Pierce | **Phoenix** | Homes straight through terrain and burns a curved tunnel. |
| Delay | **Stalker Flame** | Hovers until the target moves, then chases. |
| Volatile | **Wisp** | Zig-zags erratically toward the target, shedding sparks. |
| Absorb | **Burn Transfer** | Puts out your own burning and passes it to the target. |
| Amplify | **Sunseeker** | A large, slow orb that grows as it flies. |
| Anchor | **Sentinel Flame** | A stationary ember that launches at any enemy who comes into range. |

---

## 💧 Water

Every Water spell follows [the Matter Rule](#the-matter-rule-water-and-earth). The **Draws** column gives the cost and draw site from section 4: *caster* (reserve, then nearby water), *site* (water at the effect location), *surroundings* (water around you), or *none* (it only acts on water already in the world).

**Base behaviours per form** (the reference each modifier changes):
- **Bolt, Ice Shard:** a slug of drawn water that freezes into a spike on impact and thaws back into a puddle.
- **Nova, Maelstrom:** gathers the water around you into a vortex, pulls inward, then flings it out.
- **Beam, Hydro Cannon:** a pressurised jet fed continuously from reserve and nearby water. It stops at the first wall (Pierce drives through), and its water lands where the jet hits.
- **Ground, Flash Flood:** a crest launched from drawn water. It picks up water from pools it crosses and leaves water in low ground it fills. It stops when it runs dry.
- **Orbit, Tide Ring:** drawn droplets circle you and fall as rain when the spell ends.
- **Trail, Riverwalk:** the bolt carries a load of water and spends it laying a current. Trail length = load / 6.
- **Mine, Geyser Trap:** you pay the water when placing. The mine holds it under pressure and erupts it upward.
- **Homing, Tide Call:** a seeking globe that soaks and slows. Its water splashes down on impact.

### Bolt
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Skipping Droplet** | 40 · caster | Bounces three times, leaving a third of its water in a splash at each bounce. |
| Split | **Hail** | 48 · caster | Freezes the water into three ice pellets. They shatter into shards that thaw into small puddles. |
| Pierce | **Pressure Needle** | 32 · caster | A dense slug that drills through sand, dirt and snow. The drilled cells are **pushed aside** into the tunnel walls, not deleted. It ends as a puddle. |
| Delay | **Water Balloon** | 40 · caster, then site | Sticks where it lands, then keeps **drawing water from around the impact** for 1.5s (up to 160) before bursting. Huge next to a pond, a dribble in a desert. |
| Volatile | **Unstable Bubble** | 40 · caster | Bounces unpredictably. When it bursts, its water splits at random into water, ice and steam (the steam part is lost). |
| Absorb | **Sponge Shot** | 0 | Flies out empty. On impact it soaks up every water cell in its radius (up to 150) and streams it back into your reserve. Knockback grows with the amount soaked. |
| Amplify | **Iceberg** | 150 · caster | The whole mass freezes into one ice block that lands as a platform you can stand on. It thaws into a pond where it lies. |
| Anchor | **Icicle** | 40 · caster, then site | Sticks to a ceiling or wall and **keeps growing downward** for as long as open water within 10 cells can drip into it. Under a waterfall it becomes a column. On dry rock it stays a stub. |

### Nova
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Ripple** | none | Only works while you're touching water. A pulse runs through that water body, and any connected water in range pulses outward in turn. All force, no cost. |
| Split | **Fountains** | site ×3 | Finds the **three nearest pools** in range and erupts a geyser *out of each one*, where the water is, not around you. |
| Pierce | **Seepage** | 100 · surroundings | The wave soaks *through* porous ground (sand, dirt, snow) but not stone. It puts out fires behind a dirt wall and comes out on the far side as water. |
| Delay | **Rain Dance\*** | site (wide) | Lifts water off every pool in a wide area as visible rising mist, collects it into a cloud over the target, and rains **that same water** back down. With no water around, the clouds stay thin. |
| Volatile | **Steam Burst** | 80 · surroundings | Boils off nearby water in random vents. The water is **consumed**: you trade supply for scalding bursts of knockback. |
| Absorb | **Whirlpool** | 0 | Pulls all water in range into a vortex at your position and drags enemies in with it. Banks what the reserve can hold, and the rest pools at your feet. |
| Amplify | **Tsunami Ring** | up to 300 · surroundings | Takes all the water it can reach and throws it outward as a ring wave. Beside a lake it's devastating. In a desert it's a splash. |
| Anchor | **Spring** | site (remote) | Taps the nearest body of water within 40 cells and **pipes it** to the cast point for 10s. The source visibly drains while the spring wells up, until the source is dry. |

### Beam
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Dousing Stream** | 30/s · caster | The jet forks to nearby fires. Each fire cell put out costs one water cell as steam. |
| Split | **Sprinkler** | 36/s · caster | Three jets share one supply, so each has a third of the pressure. |
| Pierce | **Water Cutter** | 60/s · caster | A needle-thin jet. The stone it cuts is **crushed to sand** and washed along with the water. |
| Delay | **Pressure Slug** | up to 120 · caster | Fills a pressure tank during a 1.5s charge, then fires it all as one slug. Force scales with the stored amount. |
| Volatile | **Burst Pipe** | 30/s · caster | The stream sputters and sprays out sideways at random. The spray lands as puddles. |
| Absorb | **Drain Hose** | 0 | A reversed jet. It sucks water, and anyone swimming in it, along the beam toward you and into your reserve. |
| Amplify | **Torrent** | 80/s · caster | A firehose that floods the area and knocks targets far back. It empties a pond in seconds. |
| Anchor | **Frost Spray\*** | 1 per new ice cell · caster | Freezes water it hits where it stands, which costs nothing because that water is already there. Frosting dry surfaces spends one water cell per ice cell. |

### Ground
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Irrigation** | 150 · caster | Fills the nearest basin, then carries whatever's left over the ridge to the next one. Stops when empty. The flood's volume always adds up exactly. |
| Split | **Parting Waves** | 180 · caster | The water divides in half: two waves go out, one in each direction. |
| Pierce | **Aquifer** | 120 · caster | Sinks into porous ground, travels underground through sand and dirt, and comes out as a spring where it ends. Stone blocks it. |
| Delay | **Dam Break** | 150 · caster | Holds the gathered water upright as a standing wall for 1.5s, then lets it collapse forward. |
| Volatile | **Rapids** | 150 · caster | The wave's water breaks off into whirlpools that spin away to the sides. |
| Absorb | **Receding Tide** | 0 | Runs along the ground **drinking every water cell it crosses**, then flows back to you into your reserve. |
| Amplify | **Tidal Wave** | 375 · caster | Needs a lake's worth of water. A tall wave that sweeps up debris and players. |
| Anchor | **Ice Wall\*** | site | Pulls water up from the ground and pools under the target and freezes it into a wall. Height = gathered ÷ width. It thaws back into a puddle **where it stood**. |

### Orbit
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Bubble Chain** | 60 · caster | Bubbles leap onto nearby enemies and trap them briefly. Each one pops into a puddle where it caught someone. |
| Split | **Twin Tides** | 72 · caster | Two larger globes, each holding half the water, circle in opposite directions. |
| Pierce | **Seeping Ring** | 48 · caster | The droplets pass through porous terrain (sand, dirt, snow) and put out fires inside it. Stone stops them. |
| Delay | **Frost Ring** | 60 · caster | The droplets freeze over 2s, then shoot outward as ice shards that thaw where they land. |
| Volatile | **Spray Ring** | 60 · caster | Droplets fly off at random. The ring shrinks with every loss and ends when it's dry. |
| Absorb | **Bubble Shield** | 0 | Starts small and **grows from water it absorbs**: incoming Water spells, rain, and pools you walk through. Each projectile it blocks costs it water. |
| Amplify | **Water Sphere** | 200 · caster | Seals you in a bubble. You can swim through the air while its mass lasts (it drains as you move), and fire can't touch you. It ends in one big splash. |
| Anchor | **Fountain Ring** | 60 · site | The ring circles a fixed point. Placed in a pool, it keeps **refilling from the pool** for its whole duration. |

### Trail
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Canal** | site (remote) | The current is supplied by the **nearest pool**, which drains into the trail. The river runs for as long as the pool lasts. |
| Split | **Tributaries** | load ×1.2 · caster | Three thinner streams share the load. |
| Pierce | **Ice Tunnel** | 0 extra | Melts through snow, ice and packed ice only, and **refreezes the meltwater as tunnel lining**. Water-family terrain becomes a passage. |
| Delay | **Monsoon Line** | load · caster | Lays the load as mist. Two seconds later it condenses and rains down along the line. |
| Volatile | **Leaky Trail** | load · caster | Drips water, ice and steam at random. The steam part is lost. |
| Absorb | **Dry Wake** | 0 | Drinks every water cell it flies past into your reserve. |
| Amplify | **River** | load ×2.5 · caster | A wide current that pushes anything in it. |
| Anchor | **Frozen Bridge** | load · caster | Freezes the load into **packed ice** that never thaws on its own, only when heated. |

### Mine
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Pressure Network** | 60 · on placement | Triggering it sets off every Water mine you've placed. Each releases its own stored water. |
| Split | **Bubble Cluster** | 72 · on placement | Bursts into bubbles that trap anyone nearby, then pop into puddles. |
| Pierce | **Undertow** | 0 · must be placed in water | Turns the pool it sits in into a downward current that drags swimmers to the bottom. Does nothing on dry land. |
| Delay | **Flood Timer** | 150 · on placement | Bursts after 4s and floods the room with its stored water. |
| Volatile | **Wild Geyser** | 60 · on placement | Erupts in a random direction and launches the victim with it. |
| Absorb | **Freeze Trap** | 0 | Stores nothing. When triggered, it freezes **whatever water is around the victim** (the pool, wet ground, their Soaked status) into ice around them. Brutal in water, useless when dry. |
| Amplify | **Deluge** | 300 · on placement | A huge up-front cost for a room-filling flood. |
| Anchor | **Old Faithful** | 0 · must be placed in water | Erupts every 4s using the pool it sits in. The water falls back and refills the pool, so it runs as long as the pool does. |

### Homing
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Tide Chain** | 40 · caster | Spends part of its water on each soak and jumps on with the rest. Ends when empty. |
| Split | **School** | 48 · caster | Six small droplets that dart at the target. |
| Pierce | **Riptide** | 32 · caster | Travels through water and porous ground toward the target and comes up under them. Stone stops it. |
| Delay | **Lurking Puddle** | site | Turns an **existing puddle** in range into a trap that leaps at whoever comes near. |
| Volatile | **Frog** | 40 · caster | Hops erratically toward the target and loses a little water on each hop. |
| Absorb | **Dehydrate** | 0 | Drains the target's health. If they're Soaked, it also pulls that water out of them into your reserve. |
| Amplify | **Water Serpent** | 150 · caster | A long serpent of water that coils around its target, then collapses into a pool. |
| Anchor | **Ice Sentry** | 40 · caster | A floating ice eye that fires needles **made from its own body**. It shrinks with every shot until it's gone. |

---

## 🪨 Earth

Every Earth spell follows [the Matter Rule](#the-matter-rule-water-and-earth). Material identity is kept: a spell built from dirt is dirt, from brick is brick. Sand used in *structures* settles into sandstone. What a spell is made of affects how it behaves: acid eats a dirt wall (`acid 0.05`) but can't touch a stone one.

**Base behaviours per form:**
- **Bolt:** a rock **torn from the ground** in the aim direction (as Telekinesis tears cells, via `tearLooseCell`). It lands and breaks into rubble of the same material.
- **Nova, Faultline:** splits the ground around you. No mass is created; it cracks and drops what's there.
- **Beam, Trench Ray:** lifts a ridge along the line **out of a trench dug right beside it**. The name was always half the design.
- **Ground:** a wave that ploughs the surface, lifting a travelling wall out of the furrow it leaves behind.
- **Orbit:** stones torn from the ground circle you and drop as rubble when the spell ends.
- **Trail, Rubble Road:** the bolt carries a load of earth and lays it as a walkway. Bridge length = load / 5.
- **Mine, Spike Trap:** a spike **pushed up from the ground beneath**, leaving a hollow under it.
- **Homing, Sinkstone:** takes the ground out from under what it chases.

### Bolt
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Skipping Stone** | 30 · caster | Bounces along the ground and sheds a chunk of itself at each bounce. |
| Split | **Gravel Shot** | 36 · caster | Crushes the drawn rock into grit and fires it as a shotgun blast. It lands as loose sand. |
| Pierce | **Drill Rock** | 24 · caster | Tunnels through terrain. The drilled cells are **packed into the tunnel walls**, so the tunnel is lined rather than dug out. |
| Delay | **Geode** | 30 · caster | Sticks in a wall. A second later it **cracks the wall open around itself** and throws the surrounding stone out as shrapnel. |
| Volatile | **Crumbling Rock** | 30 · caster | Breaks apart mid-flight into random falling debris. |
| Absorb | **Lodestone** | 0 | On impact, pulls the loose sand, dirt and debris in range into one clump that settles into sandstone. |
| Amplify | **Boulder** | 75 · caster | Tears a big boulder out of the ground (leaving a matching crater near you) that rolls downhill. |
| Anchor | **Stone Pillar** | site | Raises a pillar where it lands, pushed up from the ground beneath, and leaves a **ring-shaped pit** around the base. |

### Nova
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Aftershock** | none | Tremors travel through **connected rock** from one structure to the next. Loose sand doesn't carry them. |
| Split | **Stone Fists** | site ×3 | Three spikes erupt around you, each pushed up from the ground beneath it. The ground sinks at each spot. |
| Pierce | **Tremor** | none | A shockwave through the ground that collapses whatever isn't supported. |
| Delay | **Seismic Stomp** | none | The ground cracks, then collapses a moment later. |
| Volatile | **Rubble Burst** | surroundings | Rips loose surface cells off the ground around you and flings them. |
| Absorb | **Compaction** | surroundings | Presses the loose earth around you into stone at **2 : 1**. The ground visibly sinks and hardens. |
| Amplify | **Cataclysm** | surroundings | A huge crater. **All** the crater's material is thrown outward as debris, none of it deleted, so it rains down all around. |
| Anchor | **Bunker** | surroundings | Pulls up the ground around you into a dome. You end up in a shallow pit under a roof made from it. |

### Beam
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Fault Line** | site | The ridge, and the trench it comes from, snakes toward nearby structures and joins them up. |
| Split | **Spike Fan** | site ×3 | Three ridges fan out, each with its own trench. |
| Pierce | **Earthquake\*** | none | An invisible underground shockwave that collapses weak terrain above its path. |
| Delay | **Stalagmite Line** | site | Spikes erupt along the line after 1s. Each leaves a hollow beneath, so the ground there becomes brittle. |
| Volatile | **Jagged Ridge** | site | A ridge of random heights with crumbling edges, above a trench of matching random depths. |
| Absorb | **Excavator** | 0 | Rips terrain loose along the beam and pulls it to you as debris, into your reserve. Overflow piles at your feet. |
| Amplify | **Obelisk Lance** | site (along the path) | Tears up cells along the whole line and forces them into a stone spear that rams forward and stays behind as a bridge. |
| Anchor | **Sandblaster** | site (under the turret) | A turret that **eats the ground beneath it** and sprays it as sand in the aimed direction. It sinks as it feeds and dies when there's nothing left underneath. |

### Ground
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Rockslide\*** | none | Finds unsupported terrain near the wave and brings it down with the world's own collapse rules. |
| Split | **Twin Furrows** | site | Two half-height ploughing waves go out, one in each direction. |
| Pierce | **Mole Run** | site | Travels underground and pushes up spikes beneath enemies from the rock below them. |
| Delay | **Fault Crack** | none | A crack runs along the ground, then the ground drops away. |
| Volatile | **Landslide\*** | none | Destabilises terrain on either side of the wave. |
| Absorb | **Quicksand Wave** | none | Loosens the ground it crosses (dirt and sandstone turn to sand, 1 : 1), and players sink. |
| Amplify | **Mountain\*** | site | A wall tall enough to block line of sight, pulled out of a **wide, deep trench right in front of it**. The moat is part of the defence. |
| Anchor | **Fortify\*** | site | Compacts the wall at **2 : 1 into stone** that acid can't dissolve. It's half the size of a normal wall for the same ground, and much harder to break. |

### Orbit
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Pebble Sling** | 60 · caster | Throws its stones at nearby enemies one at a time. The orbit shrinks with each throw. |
| Split | **Twin Moons** | 72 · caster | Two boulders circle you in opposite directions. |
| Pierce | **Grinding Ring** | 48 · caster | The stones grind through terrain as you move. What they grind **crushes to sand** and piles up below. |
| Delay | **Accretion** | 0 → collects | Collects loose debris and surface cells for 3s, then hurls it all at once. The longer it gathers, the harder it hits. |
| Volatile | **Asteroid Belt** | 60 · caster | Rocks randomly fly off orbit. |
| Absorb | **Gravel Shield** | 0 → collects | Catches incoming Earth projectiles and debris and **adds them to the shield**. Leftovers go to your reserve when it ends. |
| Amplify | **Golem Shell** | 150 · caster | Stone armour built onto you. It halves damage, each hit chips cells off as debris, and its weight slows you. |
| Anchor | **Rock Satellite** | 60 · caster | The stones circle a fixed point instead of you. |

### Trail
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Railway** | load · caster | Aims to reach solid ground at both ends. If the load runs out first, the bridge **falls short**. |
| Split | **Scree** | load ×1.2 · caster | Sheds loose gravel that slides down slopes and buries what's below. |
| Pierce | **Tunnel Bore** | 0 extra | Bores a tunnel and **compacts the spoil into a stone lining** at 2 : 1. |
| Delay | **Stalactites** | none | Loosens the rock above the path, and the ceiling's **own stone** drops as spikes. |
| Volatile | **Rock Hail** | load · caster | Rocks from the load fall at random along the path. |
| Absorb | **Erosion** | 0 | Strips sand and dirt along the path into your reserve. |
| Amplify | **Causeway** | load ×2.5 · caster | A thick, walkable bridge. |
| Anchor | **Buttress** | load · caster + site | The walkway grows support pillars down to the ground below, drawn from where they land, so it holds itself up. |

### Mine
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Collapse Charge** | none | Triggering it sets off a structural collapse that spreads. |
| Split | **Caltrops** | site | Shatters the surface cells around it into sharp grit that slows anyone walking over it. |
| Pierce | **Impaler** | site (deep) | A long spike driven up from deep underground. It leaves a tall shaft behind. |
| Delay | **Cave-in** | none | The ceiling above caves in after it's triggered. |
| Volatile | **Frag Rock** | site | The ground at the mine explodes into shrapnel and leaves a crater. |
| Absorb | **Sinkhole\*** | 0 → collects | The ground gives way beneath the victim. The removed earth goes to your reserve, and the rest is **packed into the pit walls**. |
| Amplify | **Uplift** | site | Raises a whole platform with the victim on top. It's pulled up from beneath, so it stands **over a hollow** and may not stay up. |
| Anchor | **Stone Sentinel** | site | A spike that **pulls back into its own hole** after each strike, ready to rearm. |

### Homing
| Mod | Ability | Draws | Effect |
|---|---|---|---|
| Chain | **Rolling Stones** | 30 · caster | Rolls on to the next target after each hit, leaving a chunk of itself behind each time. |
| Split | **Pebble Swarm** | 36 · caster | A swarm of small homing pebbles. |
| Pierce | **Burrower** | 24 · caster | Tunnels toward the target, packing the cells it moves into the tunnel walls, and comes up under them. |
| Delay | **Dormant Boulder** | 30 · caster | Waits embedded in the ground, then breaks free and rolls at the target. |
| Volatile | **Tumbler** | 30 · caster | Bounces unpredictably toward the target. |
| Absorb | **Rooting Stone** | 0 · site | Pulls up the ground around the target's feet and pins them. Uses the ground they stand on, so it can't root anyone on timber or ice. |
| Amplify | **Juggernaut** | 75 · caster | A boulder that **picks up the ground it rolls over** and grows like a snowball, leaving a groove behind it. |
| Anchor | **Stone Watcher** | 60 · caster | A turret that throws **pieces of its own body**. It shrinks with each shot and can reload by picking up nearby debris. |

---

## ⚡ Lightning

### Bolt
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Chain Lightning** | Jumps between up to five targets. |
| Split | **Forked Bolt\*** | One bolt visibly forks into three strike points. |
| Pierce | **Railgun** | An instant line that hits everything along it. |
| Delay | **Thunderclap** | A strike falls from the sky at the aim point after 1s. |
| Volatile | **Ball Lightning** | A slow, erratic orb that crackles. |
| Absorb | **Grounding** | Cancels enemy lightning and gives you charge. |
| Amplify | **Thunderbolt** | A massive strike that stuns everything nearby. |
| Anchor | **Lightning Rod** | Plants a rod that attracts every bolt nearby. |

### Nova
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Storm Call\*** | Arcs to every player in range at the same moment. |
| Split | **Tri-Strike** | Three sky strikes land around you. |
| Pierce | **EMP Pulse** | Passes through walls and blocks casting briefly. |
| Delay | **Static Charge** | The next thing to touch you gets shocked. |
| Volatile | **Storm Front\*** | Random strikes spread across a wide area. |
| Absorb | **Discharge Sink** | Pulls electricity out of the water around you and heals you. |
| Amplify | **Thunderdome** | A huge shock that stuns everyone caught in it. |
| Anchor | **Static Field** | Leaves an electrified zone that lasts. |

### Beam
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Arc Welder** | The beam arcs between several enemies at once. |
| Split | **Trident Arc** | Three arcs at once. |
| Pierce | **Ground Fault\*** | Arcs underground through buried water and acid. |
| Delay | **Capacitor Blast** | Charges for 1.5s, then fires one heavy beam. |
| Volatile | **Wild Arc** | The beam flails around at random. |
| Absorb | **Energy Tether** | Drains the target and builds up your Overcharge. |
| Amplify | **Plasma Beam** | Melts sand into glass and stone into lava. |
| Anchor | **Tesla Link** | A live arc runs between you and a fixed point. Anyone who crosses it gets shocked. |

### Ground
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Conduction Wave** | Electrifies every connected body of water it reaches. |
| Split | **Twin Currents** | Two waves go out, one in each direction. |
| Pierce | **Buried Current** | Travels underground and shocks anyone standing above it. |
| Delay | **Rolling Thunder** | Travels silently, then lightning strikes along its whole path. |
| Volatile | **Crackle Wave** | Throws off random sparks as it travels. |
| Absorb | **Grounding Wave** | Neutralises electrified water and enemy traps. |
| Amplify | **Thunder Road** | A tall electric wave that stuns everything it passes. |
| Anchor | **Electric Fence** | A crackling barrier that stays up. |

### Orbit
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Spark Sentry** | Sparks arc to anyone who comes close. |
| Split | **Binary Star** | Two charged orbs circle you. |
| Pierce | **Faraday Ring** | Shocks through walls. |
| Delay | **Capacitor Ring** | Builds up charge, then releases it all at once. |
| Volatile | **Plasma Storm** | Sparks break away at random. |
| Absorb | **Overcharge\*** | Banks charge that powers up your next spell. |
| Amplify | **Storm Avatar** | You become charged and move faster. |
| Anchor | **Magnetosphere** | The orbit locks onto the enemy you hit instead of you. |

### Trail
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Power Line** | Lightning runs back and forth along the trail. |
| Split | **Branching Trail** | The trail splits into branches. |
| Pierce | **Fulgurite** | Melts a glass tunnel through terrain. |
| Delay | **Glass Scar** | Turns sand along the path to glass, which shatters into shards 2s later. |
| Volatile | **Static Crackle** | Sparks flicker along the trail at random. |
| Absorb | **Null Line** | No one can cast while standing on it. |
| Amplify | **Lightning Highway** | A charged trail that speeds up anyone on it. |
| Anchor | **Live Wire** | An electrified trail that stays. |

### Mine
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Relay Rune** | Triggering it sets off all your runes. |
| Split | **Spark Caltrops** | Scatters sparks that shock anyone walking over them. |
| Pierce | **Buried Coil** | Shocks up from underground, through the terrain. |
| Delay | **Storm Brewing\*** | Clouds gather, then a strike hits the whole area. |
| Volatile | **Unstable Capacitor** | Releases random discharges. |
| Absorb | **Spell Sink** | Catches the next enemy spell cast nearby and fires it back as lightning. |
| Amplify | **Thunderpit** | A huge area discharge. |
| Anchor | **Tesla Coil\*** | A turret that keeps firing and never stops. |

### Homing
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Storm Chain** | Jumps to every target you've marked. |
| Split | **Spark Swarm** | A swarm of tiny homing sparks. |
| Pierce | **Lock-On** | Goes straight through walls to its target. |
| Delay | **Sky Lock** | Marks the target, then a strike falls on them 1.5s later. |
| Volatile | **Electric Wisp** | A fast spark that darts erratically toward its target. |
| Absorb | **Charge Leech** | Steals the target's casting cooldown. |
| Amplify | **Zeus's Lance** | A devastating strike that locks on. |
| Anchor | **Magnetic Lock** | Roots the target in place for 1.5s. |

---

## 🌑 Dark

### Bolt
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Plague\*** | The curse keeps spreading to players who come near a cursed player. |
| Split | **Triple Curse\*** | Three bolts aimed at three different players. |
| Pierce | **Wraith Step\*** | Flies straight through walls. |
| Delay | **Slow Death\*** | The curse gets worse the longer it lasts. |
| Volatile | **Hex Roulette** | Applies a random curse: slow, blind, inverted controls or damage over time. |
| Absorb | **Buff Thief** | Steals the target's active buffs. |
| Amplify | **Despair** | Lowers the target's maximum health. |
| Anchor | **Haunt** | A ghost follows the target for 5s and reveals where they are. |

### Nova
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Dread Spread** | The fear jumps from player to player. |
| Split | **Echoes** | Three shadow copies of you appear to confuse enemies. |
| Pierce | **Night Terror** | Passes through walls. |
| Delay | **Eclipse** | Darkness builds up, then the curse lands. |
| Volatile | **Panic\*** | Controls glitch and the screen shakes. |
| Absorb | **Harvest\*** | Drains everyone in range and heals you. |
| Amplify | **Blackout** | Darkens the vision of every player in range. |
| Anchor | **Shadow Zone** | Leaves a patch of darkness that lasts. |

### Beam
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Soul Link** | Links two enemies, so damage to one hurts both. |
| Split | **Tendrils** | Three draining beams at once. |
| Pierce | **Void Gaze** | Drains through walls. |
| Delay | **Death Stare** | Hold it on a target for 2s, then it deals massive damage. |
| Volatile | **Chaos Tendril** | Whips around and hits at random. |
| Absorb | **Life Swap** | Swaps your health percentage with the target's. |
| Amplify | **Oblivion Ray** | Drains health very quickly. |
| Anchor | **Shadow Chain** | Chains the target to a fixed spot so they can't leave. |

### Ground
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Shadow Crawl** | The wave jumps to any cursed player. |
| Split | **Twin Shadows** | Two shadow waves go out, one in each direction. |
| Pierce | **Underworld Tide** | Travels underground and curses anyone above it. |
| Delay | **Rising Dead** | Shadowy hands rise after 1.5s and root anyone in place. |
| Volatile | **Nightmare Wave** | Disorients players at random as it passes. |
| Absorb | **Shadow Recall** | The wave returns to you and brings back healing. |
| Amplify | **Black Tide** | A big wave that blinds whoever it hits. |
| Anchor | **Barrier of Souls** | A wall that curses anyone who passes through. |

### Orbit
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Soul Wisps** | Wisps jump to nearby enemies. |
| Split | **Twin Wraiths** | Two wraiths circle you. |
| Pierce | **Phantom Ring** | Passes through walls. |
| Delay | **Death's Toll** | Builds up curses, then releases them all at once. |
| Volatile | **Poltergeist** | Wraiths strike at random. |
| Absorb | **Soul Shield** | Absorbs damage and turns it into healing. |
| Amplify | **Reaper Form** | A large scythe aura that curses whatever it touches. |
| Anchor | **Haunted Ground** | The wraiths circle a fixed point. |

### Trail
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Cursed Path** | The curse spreads along the trail to anyone touching it. |
| Split | **Shadow Branches** | The trail splits into branches. |
| Pierce | **Ghost Trail** | Passes through walls. |
| Delay | **Dormant Curse** | The curse activates 2s after the trail is laid. |
| Volatile | **Chaos Wake** | Applies random debuffs. |
| Absorb | **Life Leech Trail** | Drains anyone standing on it. |
| Amplify | **Wake of Sorrow** | A large cursed zone. |
| Anchor | **Gravelands** | A cursed trail that lasts. |

### Mine
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Hex Chain** | Triggering it sets off all your Dark mines. |
| Split | **Curse Seeds** | Scatters several small curse mines. |
| Pierce | **Buried Hex** | Rises up through terrain. |
| Delay | **Slow Hex** | The curse builds up after the mine is triggered. |
| Volatile | **Chaos Hex** | Applies a random curse. |
| Absorb | **Soul Trap** | Drains the victim and banks the health for you. |
| Amplify | **Doom Trap** | A massive curse. |
| Anchor | **Soul Anchor\*** | A respawn beacon. |

### Homing
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Soul Hunter** | Moves from one cursed target to the next. |
| Split | **Shadow Swarm** | A swarm of small homing curses. |
| Pierce | **Phantom Seeker** | Goes through walls. |
| Delay | **Death Mark** | Marks the target, and the curse lands after 2s. |
| Volatile | **Chaos Seeker** | Moves erratically and applies a random curse. |
| Absorb | **Soul Siphon** | Drains the target and heals you. |
| Amplify | **Reaper's Call** | A huge homing curse. |
| Anchor | **Shadow Watcher** | A fixed shadow that curses anyone who gets close. |

---

## ✨ Arcane

### Bolt
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Arcane Chain** | Erases terrain at each jump. |
| Split | **Arcane Scatter** | Three bolts that erase terrain. |
| Pierce | **Void Lance** | Erases a line through terrain. |
| Delay | **Rift Charge** | A rift opens after 1s. |
| Volatile | **Chaos Bolt** | A random effect on impact. |
| Absorb | **Implosion** | Pulls debris and players inward. |
| Amplify | **Void Orb** | A huge erasure. |
| Anchor | **Rift Point** | A stable rift that lasts. |

### Nova
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Rupture Chain** | Sets off further ruptures nearby. |
| Split | **Tri-Rupture** | Three ruptures around you. |
| Pierce | **Void Pulse** | Passes through walls. |
| Delay | **Void Build** | Charges, then ruptures. |
| Volatile | **Chaos Rupture** | Erases at random. |
| Absorb | **Singularity** | Pulls everything inward. |
| Amplify | **Cataclysmic Rupture** | A massive erasure. |
| Anchor | **Void Zone** | Leaves an erasure zone that lasts. |

### Beam
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Unraveling\*** | Seeks out and erases support cells. |
| Split | **Trident Ray** | Three rays at once. |
| Pierce | **Void Ray** | Erases through everything. |
| Delay | **Charged Disintegration** | Charges, then fires. |
| Volatile | **Chaos Ray** | Erases at random. |
| Absorb | **Telekinetic Beam** | Pulls objects toward you. |
| Amplify | **Annihilation Ray** | A huge erasure. |
| Anchor | **Void Turret** | A turret that fires on its own. |

### Ground
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Rift Chain** | Spreads to further rifts. |
| Split | **Twin Rifts** | Two waves go out, one in each direction. |
| Pierce | **Void Tunnel** | Travels underground, erasing as it goes. |
| Delay | **Rift Crack** | Opens after a delay. |
| Volatile | **Chaos Rift** | Erases at random. |
| Absorb | **Rift Pull** | Pulls debris inward. |
| Amplify | **Great Rift** | A huge erasure wave. |
| Anchor | **Rift Wall** | A barrier that lasts. |

### Orbit
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Ward Chain** | Jumps to enemies. |
| Split | **Twin Wards** | Two shards. |
| Pierce | **Phase Ward** | Passes through walls. |
| Delay | **Ward Burst** | Builds up, then releases. |
| Volatile | **Chaos Ward** | Random deflections. |
| Absorb | **Telekinesis\*** | Grabs debris and throws it. |
| Amplify | **Grand Ward** | A large shield. |
| Anchor | **Ward Totem** | A fixed ward. |

### Trail
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Erasure Chain** | Spreads erasure to nearby cells. |
| Split | **Branching Erasure** | The trail splits into branches. |
| Pierce | **Void Path** | Erases through everything. |
| Delay | **Delayed Erasure** | Erases after a delay. |
| Volatile | **Chaos Line** | Erases at random. |
| Absorb | **Pull Line** | Pulls objects toward the trail. |
| Amplify | **Great Erasure** | A wide erasure. |
| Anchor | **Portal Line** | A teleport trail. |

### Mine
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Null Chain** | Disarms and chains to other mines. |
| Split | **Null Scatter** | Several small null mines. |
| Pierce | **Buried Null** | Rises up through terrain. |
| Delay | **Delayed Null** | Disarms after a delay. |
| Volatile | **Chaos Null** | A random effect. |
| Absorb | **Null Sink** | Absorbs spells. |
| Amplify | **Great Null** | A huge disarm. |
| Anchor | **Rift Anchor\*** | A portal you can return to. |

### Homing
| Mod | Ability | Effect |
|---|---|---|
| Chain | **Seeker Chain** | Jumps to the next target. |
| Split | **Seeker Swarm** | A swarm of homing rifts. |
| Pierce | **Phase Seeker** | Goes through walls. |
| Delay | **Lurking Rift** | Waits, then strikes. |
| Volatile | **Flicker Rift** | Blinks toward the target in short, random teleports. |
| Absorb | **Pulling Seeker** | Pulls the target inward. |
| Amplify | **Great Seeker** | A huge homing rift. |
| Anchor | **Seeker Sentry** | A fixed seeker. |

---

## Implementation notes (Water & Earth)

All paths are in `spells.js` unless noted.

### Water: built

The matter layer is the `matter` section of `spells.js`, just above `ELEMENTS`.

- **The pool.** `gatherForCast()` pays for a cast before it exists: reserve first, then `drawWater()` from the world. The result is `ctx.matter = { left, total, cost, parts }`, one object shared by every copy of `ctx` the cast spreads into. Every Water write spends from it through `wetCell()` / `wetFromPool()` / `pourWater()`. Nothing else in the codebase writes Water cells for a spell.
- **Rationing.** `impactShare()` decides how much of the pool one impact may use:
  - Split impacts take even shares (`parts`).
  - Chain, Volatile and Anchor keep half back for their jumps, vents and pulses.
  - Ground waves carry their own `load`, and orbits spend a fixed `waterPerTick`.
- **Drawing.** `drawWater()` walks a disc (radius 28) nearest-first. Liquid levels itself, so nearest-first still drains a pool from the top. It checks the open path (`waterPathClear`) and the footing guard, erases each drawn cell, and streams a sample of them to the caster. The wind-up comes from how much was drawn and how far away it was. `cast()` delays the launch by that long, then launches from wherever the caster is by then.
- **Site draws.** Ice Wall and Rain Dance carry `drawsAtSite` and gather their own water. Ice Wall freezes water already standing in its shape for free and draws the rest from pools around its base. Rain Dance lifts up to 300 cells from around the caster and rains exactly that amount back down.
- **Channels.** `channelDraw()` tops the nozzle up to 0.2s of flow every frame, and the spray ends 0.25s after it runs dry. Hydro Cannon no longer paints water along the whole ray: it stops at the first wall (Pierce excepted), and `channelRayEnd()` pours its water there. `channelEnd()` returns what's left in the nozzle to the reserve.
- **Absorb.** Drought, Receding Tide, Dry Wake, the Absorb orbit and Drain Hose all drink liquid water into the reserve through `bankWater()`. Overflow splashes down at the caster's feet. Drought no longer removes acid.
- **Pierce.** A piercing water bolt's `pierceStep()` melts the ice and snow it bores through into its own load instead of deleting them. Rock is still dug out by the shared `digCircle`.
- **Reserve and HUD** (`game.js`):
  - `this.reserve` sits next to `this.status`.
  - `Spells.wade()` refills the reserve at 40 cells/s from the pool you stand in.
  - The blue gauge under the health bar shows the reserve and flashes red when a cast fails.
  - Each Water slot's HUD line gets a `waterReadout()`, and the status lines explain a fizzle.
- `SandScene.douseCell` is gone. It was the free-water path.
- **Multiplayer** needs no protocol change: drawn cells are `setCell` writes and ship in the existing `cells` message.
- **Known leak:** a pour that finds no open cell within 28 cells (an impact deep under a lake) merges into the water around it. Snow's half-cells can round away.

### Earth: to do

| Location | Currently | Becomes |
|---|---|---|
| `raiseBarrier` (Fortify, Mountain) | `placeCircle` from nothing | a site draw beneath and in front of the barrier. Height comes from what was gathered. Fortify compacts 2 : 1. |
| `Earth.impact` (generic) | writes `STONE`/`SAND` over a disc | the boulder's own torn-out cells scatter as rubble. |
| `Earth.impact` (Mine) | writes a `STONE` spike | pushes cells up from beneath, leaving a hollow. |
| `Earth.beamStep` (Trench Ray) | writes a `STONE` ridge | moves cells from a trench beside the ridge. |
| `Earth.groundStep`, `orbitTick`, `trailStep` | write `STONE` | ploughed, torn or carried cells, keeping their material. |
| `Earth.absorb` (Sinkhole) | deletes solid cells | banks them into the reserve and packs the overflow into the pit walls. |
| `digCircle` (`game.js`, the dig tool) | deletes cells | puts dug earth into the Earth reserve up to its cap. The rest is still deleted (the sandbox tool stays a sandbox tool). |

The Water helpers (`drawWater`, `pourWater`, the pool and rationing) are the pattern to follow. Earth needs its own source table and draw speed for hard rock, and should move matter through `spawnDebris` as `tearLooseCell` already does.

**Unchanged by the Matter Rule:** Faultline, Earthquake, Rockslide, Landslide and Sinkstone already only destabilise or remove terrain. They create nothing and stay as they are, apart from routing removals into the reserve where the entry says so.
