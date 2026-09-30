import ObjType from '#/cache/config/ObjType.js';
import LocType from '#/cache/config/LocType.js';
import NpcType from '#/cache/config/NpcType.js';
import InvType from '#/cache/config/InvType.js';
import Packet from '#/io/Packet.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import Player from '#/engine/entity/Player.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { Inventory } from '#/engine/Inventory.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import World from '#/engine/World.js';

// Ambient "population" bots: real headless Players (no client -- see NetworkPlayer.isClientConnected)
// driven by a tiny per-tick loop instead of packets, reusing the same setInteraction/executeScript
// paths a real click would use. No save file, no persistence -- ephemeral, recreated on each boot.
//
// Deliberately NOT covered here (each needs its own protocol research before it's worth building):
// fletching (knife+logs opens a "how many to make" chooser interface, not a fire-and-forget script
// like firemaking), alchemy (spell-cast-on-item isn't in ServerTriggerType at all -- unclear what
// packet/component drives it), agility (would need the real course's obstacle loc sequence, not
// guessed coordinates).

const CHOP_OP = ServerTriggerType.APLOC1; // tree op[0] "Chop down"
const FISH_OP = ServerTriggerType.APNPC1; // op[0] on every spot type below ("Lure"/"Net"/"Cage")
const ATTACK_OP = ServerTriggerType.APNPC1 + 1; // goblin op[1] "Attack"
const TAKE_OP = ServerTriggerType.APOBJ1 + 2; // coins op[2] "Take"

// Confirmed live distances so far: nearest tree 14 tiles, nearest goblin 3 -- 25 was a guess with
// way more margin than reality needs, and a failed scan's cost is quadratic in radius (worst case,
// the exact case backoff exists for). Widen only if a real bot placement turns out to need it.
const LOC_SEEK_RADIUS = 18;
const NPC_SEEK_RADIUS = 15;
const LOOT_RADIUS = 5;
const HOME_DRIFT_LIMIT = 30; // if a fight-bot dies and respawns elsewhere, walk it back home instead of chasing it

// A seek that finds nothing (or finds something the bot can never actually reach, e.g. across
// water) retries every SEEK_INTERVAL_BASE ticks forever unless backed off -- fine on a fast dev
// machine, but confirmed to visibly stall tick processing on the R36S (2026-09-30: three fishermen
// with no reachable spot at all, doing a full radius-25 NPC zone scan every 5 ticks, forever). Each
// failed attempt doubles the wait, up to SEEK_INTERVAL_MAX; any tick the bot has a real target
// resets it back to base, so bots that are actually working stay responsive.
const SEEK_INTERVAL_BASE = 5;
// A permanently-stuck bot's cost is (population count / this), so this is the main scaling knob
// for "many more bots" -- 1000 ticks = ~10min between retries for something that's been failing
// the whole time. A working bot never gets near this; it keeps resetting to SEEK_INTERVAL_BASE.
const SEEK_INTERVAL_MAX = 1000;
// A target that gets set then clears again within a few ticks (e.g. the ranger-out-of-ammo bug
// below) isn't "sticking" -- it just LOOKS like a success every time we check, which used to reset
// seekInterval back to base on every single one of those ticks and pinned the backoff at its
// minimum forever (confirmed live 2026-09-30: stuck at 5 for 100+ seconds straight). Requiring the
// target to survive this many consecutive ticks before counting as a real success is cheap
// insurance against that whole class of bug, not just the one instance found so far.
const TARGET_STICK_TICKS = 3;

// Rest, don't immediately re-engage, once HP drops below this fraction of max -- the fighter bot
// was otherwise found to chip away net HP fight after fight (10->9->8->7->6->5->4 observed live,
// 2026-09-30) since it re-engaged a new goblin the instant the last one died, never leaving itself
// a window to regen. Resume once healed back above the (higher) resume fraction -- hysteresis so
// it doesn't flap in and out of resting right at the threshold.
const REST_HP_FRACTION = 0.3;
const REST_RESUME_FRACTION = 0.8;

// These are all ObjType/LocType/NpcType/InvType ids, only resolvable once the cache configs are
// loaded (World.reload(), during start()) -- NOT at module-import time, which happens earlier
// (World.ts imports this module at the top of the file, before start() ever runs). Resolving
// lazily on first real use avoids every id silently coming back -1.
let ids: {
    inv: number;
    tree: number;
    logs: number;
    tinderbox: number;
    fishSpots: number[];
    net: number;
    fishingRod: number;
    feather: number;
    harpoon: number;
    lobsterPot: number;
    goblin: number;
    goblinTypes: number[];
    coins: number;
} | null = null;

function getIds() {
    if (!ids) {
        const goblin = NpcType.getId('goblin');
        ids = {
            inv: InvType.getId('inv'),
            tree: LocType.getId('tree'),
            logs: ObjType.getId('logs'),
            tinderbox: ObjType.getId('tinderbox'),
            fishSpots: [NpcType.getId('freshfish'), NpcType.getId('saltfish'), NpcType.getId('rarefish'), NpcType.getId('memberfish')],
            net: ObjType.getId('net'),
            fishingRod: ObjType.getId('fishing_rod'),
            feather: ObjType.getId('feather'),
            harpoon: ObjType.getId('harpoon'),
            lobsterPot: ObjType.getId('lobster_pot'),
            goblin,
            goblinTypes: [goblin], // hoisted -- findNearestNpc takes an array, no reason to allocate one every seek
            coins: ObjType.getId('coins')
        };
    }
    return ids;
}

// Randomized warrior/ranger/mage loadouts for the goblin fighter -- one archetype picked per
// spawn. A "mage" here just autoattacks in melee range with a staff equipped: staves are real
// melee-capable weapons with their own combat bonuses in this engine, same as a sword, so this
// gets a visually/mechanically distinct mage without needing actual spell-casting (still unknown,
// see the module comment above on alchemy). Every entry is [wearpos slot, item id]; one random
// pick per pool, pools may be shorter than others -- gear is additive, not a fixed 12-slot fit.
type Archetype = 'warrior' | 'ranger' | 'mage';

interface ArchetypeDef {
    stats: [stat: number, min: number, max: number][];
    gearPools: [wearpos: number, itemId: number, count: number][][]; // each inner array is one equipment slot's pool of options
}

let archetypes: Record<Archetype, ArchetypeDef> | null = null;

function getArchetypes(): Record<Archetype, ArchetypeDef> {
    if (!archetypes) {
        const id = (name: string) => ObjType.getId(name);
        archetypes = {
            warrior: {
                stats: [
                    [PlayerStat.HITPOINTS, 20, 35],
                    [PlayerStat.ATTACK, 10, 25],
                    [PlayerStat.STRENGTH, 10, 25],
                    [PlayerStat.DEFENCE, 10, 25]
                ],
                gearPools: [
                    [
                        [3, id('bronze_sword'), 1],
                        [3, id('iron_sword'), 1],
                        [3, id('bronze_scimitar'), 1],
                        [3, id('iron_scimitar'), 1]
                    ],
                    [
                        [5, id('wooden_shield'), 1],
                        [5, id('bronze_sq_shield'), 1]
                    ],
                    [
                        [4, id('bronze_platebody'), 1],
                        [4, id('leather_armour'), 1]
                    ],
                    [[7, id('leather_chaps'), 1]],
                    [
                        [0, id('bronze_med_helm'), 1],
                        [0, id('bronze_full_helm'), 1]
                    ],
                    [[9, id('leather_gloves'), 1]],
                    [[10, id('leather_boots'), 1]]
                ]
            },
            ranger: {
                stats: [
                    [PlayerStat.HITPOINTS, 18, 30],
                    [PlayerStat.RANGED, 10, 25],
                    [PlayerStat.DEFENCE, 5, 15]
                ],
                gearPools: [
                    [
                        [3, id('shortbow'), 1],
                        [3, id('longbow'), 1]
                    ],
                    // ammo is a stack, not a single item -- equipping count:1 here was the actual
                    // bug behind "attacks once then just stands there": one shot fires, the bot
                    // runs out of arrows, and every seek after that re-engages a fresh (fruitless)
                    // fight that can never land another hit, pinning the backoff at its minimum
                    // interval forever (confirmed live 2026-09-30: seekInterval stuck at 5 for
                    // 100+ seconds straight, re-scanning for a goblin every ~5-8 ticks the whole
                    // time -- the actual dominant cost behind that session's worse lag/fps drops).
                    [
                        [13, id('bronze_arrow'), 999],
                        [13, id('iron_arrow'), 999]
                    ],
                    [[4, id('leather_armour'), 1]],
                    [[7, id('leather_chaps'), 1]],
                    [[9, id('leather_gloves'), 1]],
                    [[10, id('leather_boots'), 1]]
                ]
            },
            mage: {
                stats: [
                    [PlayerStat.HITPOINTS, 15, 28],
                    [PlayerStat.MAGIC, 10, 25],
                    [PlayerStat.DEFENCE, 5, 15]
                ],
                gearPools: [
                    [
                        [3, id('plainstaff'), 1],
                        [3, id('staff_of_fire'), 1],
                        [3, id('mystic_fire_staff'), 1]
                    ],
                    [
                        [4, id('wizards_robe'), 1],
                        [4, id('black_robe'), 1]
                    ]
                ]
            }
        };
    }
    return archetypes;
}

function randInt(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function pickOne<T>(pool: T[]): T {
    return pool[Math.floor(Math.random() * pool.length)];
}

function equipArchetype(bot: Player, def: ArchetypeDef): void {
    for (const [stat, min, max] of def.stats) {
        bot.setLevel(stat, randInt(min, max));
    }

    const worn = bot.getInventory(InvType.WORN);
    if (worn) {
        for (const pool of def.gearPools) {
            const [wearpos, itemId, count] = pickOne(pool);
            worn.set(wearpos, { id: itemId, count });
        }
        bot.buildAppearance(InvType.WORN);
    }
}

type BotKind = 'woodcutter' | 'fisherman' | 'firemaker' | 'goblin_fighter';

interface BotEntry {
    player: Player;
    kind: BotKind;
    homeX: number;
    homeZ: number;
    level: number;
    nextSeekTick: number;
    seekInterval: number;
    resting: boolean;
    targetHeldTicks: number;
}

const bots: Set<BotEntry> = new Set();

function spawn(kind: BotKind, username: string, x: number, z: number, level: number, grant: (bot: Player, inv: Inventory) => void): void {
    const bot = PlayerLoading.load(username, new Packet(new Uint8Array(0)), null);
    bot.x = x;
    bot.z = z;
    bot.level = level;

    const inv = bot.getInventory(getIds().inv);
    if (inv) {
        grant(bot, inv);
    }

    // stagger first seek so a large bot population doesn't all scan on the same tick at boot
    const nextSeekTick = Math.floor(Math.random() * SEEK_INTERVAL_BASE);
    bots.add({ player: bot, kind, homeX: x, homeZ: z, level, nextSeekTick, seekInterval: SEEK_INTERVAL_BASE, resting: false, targetHeldTicks: 0 });
    World.newPlayers.add(bot);
}

// Call once per tick a seek is actually attempted (i.e. the bot had no target and was due).
// Backs off further every time -- reset happens separately, wherever bot.target is seen set.
function backoffSeek(entry: BotEntry): void {
    entry.nextSeekTick = World.currentTick + entry.seekInterval;
    entry.seekInterval = Math.min(entry.seekInterval * 2, SEEK_INTERVAL_MAX);
}

export function spawnWoodcutterBot(username: string, x: number, z: number, level: number): void {
    spawn('woodcutter', username, x, z, level, (_bot, inv) => inv.add(getIds().tinderbox, 1));
}

export function spawnFishermanBot(username: string, x: number, z: number, level: number): void {
    spawn('fisherman', username, x, z, level, (_bot, inv) => grantFishingGear(inv));
}

export function spawnFiremakingBot(username: string, x: number, z: number, level: number): void {
    // ponytail: no real bank interaction -- just tops the logs back up directly when it runs out,
    // standing in for "walked to the bank and withdrew more". Upgrade to a real OpLoc bank
    // withdrawal if the bot should ever look like it's actually banking.
    spawn('firemaker', username, x, z, level, (_bot, inv) => {
        inv.add(getIds().tinderbox, 1);
        inv.add(getIds().logs, inv.freeSlotCount);
    });
}

export function spawnGoblinFighterBot(username: string, x: number, z: number, level: number): void {
    spawn('goblin_fighter', username, x, z, level, bot => {
        const pool = getArchetypes();
        const archetype = pickOne(Object.keys(pool) as Archetype[]);
        equipArchetype(bot, pool[archetype]);
    });
}

function grantFishingGear(inv: Inventory): void {
    // one bot, whichever fishing-spot type it finds nearest (shrimp net, fly-fished trout, lobster
    // cage, harpooned tuna) -- carry every early tool so any of them works.
    const { net, fishingRod, feather, harpoon, lobsterPot } = getIds();
    inv.add(net, 1);
    inv.add(fishingRod, 1);
    inv.add(feather, 5);
    inv.add(harpoon, 1);
    inv.add(lobsterPot, 1);
}

// Ring-by-ring (Chebyshev distance), not a raster box scan -- a raster scan returns the first
// match in dx-major order, which can be much farther away than the true nearest one and land
// outside the pathfinder's reach, so the bot repeatedly targets something it can never walk to.
function findNearestLoc(x: number, z: number, level: number, locTypeId: number, radius: number) {
    for (let r = 0; r <= radius; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) {
                    continue;
                }
                const loc = World.getLoc(x + dx, z + dz, level, locTypeId);
                if (loc) {
                    return loc;
                }
            }
        }
    }
    return null;
}

function findNearestObj(x: number, z: number, level: number, objTypeId: number, hash64: bigint, radius: number) {
    for (let r = 0; r <= radius; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) {
                    continue;
                }
                const obj = World.getObj(x + dx, z + dz, level, objTypeId, hash64);
                if (obj) {
                    return obj;
                }
            }
        }
    }
    return null;
}

function findNearestNpc(x: number, z: number, level: number, typeIds: number[], radius: number) {
    let best = null;
    let bestDist = Infinity;

    for (let dx = -radius; dx <= radius; dx += 8) {
        for (let dz = -radius; dz <= radius; dz += 8) {
            for (const npc of World.gameMap.getZone(x + dx, z + dz, level).getAllNpcsSafe(true)) {
                if (!typeIds.includes(npc.type)) {
                    continue;
                }

                const dist = Math.max(Math.abs(npc.x - x), Math.abs(npc.z - z));
                if (dist <= radius && dist < bestDist) {
                    best = npc;
                    bestDist = dist;
                }
            }
        }
    }

    return best;
}

function useHeldOnHeld(bot: Player, primary: number, secondary: number): void {
    // same guard OpHeldUHandler leads with -- without it we re-trigger the action's script every
    // tick, before its own animation/delay (e.g. firemaking) ever gets a chance to complete.
    if (bot.delayed) {
        return;
    }

    const inv = bot.getInventory(getIds().inv);
    const primarySlot = inv?.getItemIndex(primary) ?? -1;
    const secondarySlot = inv?.getItemIndex(secondary) ?? -1;
    if (primarySlot === -1 || secondarySlot === -1) {
        return;
    }

    bot.lastItem = primary;
    bot.lastSlot = primarySlot;
    bot.lastUseItem = secondary;
    bot.lastUseSlot = secondarySlot;

    // same [opheldu,b] / [opheldu,a] / [opheldu,b_category] / [opheldu,a_category] fallback chain
    // OpHeldUHandler uses for a real click -- firemaking in particular is only registered against
    // logs' shared category (one script for every log type), not the "logs" ObjType id directly.
    const primaryType = ObjType.get(primary);
    const secondaryType = ObjType.get(secondary);

    let script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, primary, -1);
    if (!script) {
        script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, secondary, -1);
        [bot.lastItem, bot.lastUseItem] = [bot.lastUseItem, bot.lastItem];
        [bot.lastSlot, bot.lastUseSlot] = [bot.lastUseSlot, bot.lastSlot];
    }
    if (!script && primaryType.category !== -1) {
        script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, -1, primaryType.category);
    }
    if (!script && secondaryType.category !== -1) {
        script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, -1, secondaryType.category);
        [bot.lastItem, bot.lastUseItem] = [bot.lastUseItem, bot.lastItem];
        [bot.lastSlot, bot.lastUseSlot] = [bot.lastUseSlot, bot.lastSlot];
    }

    if (script) {
        bot.executeScript(ScriptRunner.init(script, bot), true);
    }
}

// Every bot is active today -- Phase 2 of the scaling design adds a dormant/active split.
export function getActiveBotCount(): number {
    return bots.size;
}

export function tick(): void {
    const { inv: INV, tree: TREE, logs: LOGS, tinderbox: TINDERBOX, fishSpots: FISH_SPOTS, goblinTypes: GOBLIN_TYPES, coins: COINS } = getIds();

    for (const entry of bots) {
        const bot = entry.player;
        if (bot.loggingOut) {
            bots.delete(entry);
            continue;
        }

        // A headless bot is a plain Player, not a NetworkPlayer -- it never goes through the
        // packet-handling path that bumps lastConnected/lastResponse for a real client
        // (NetworkPlayer.ts:63 and :80). Without this, processLogouts()'s existing
        // no-connection/no-response timeouts (World.TIMEOUT_NO_CONNECTION, 50 ticks, checked first;
        // World.TIMEOUT_NO_RESPONSE, 100 ticks) eventually force-log every bot out as if it silently
        // disconnected. Confirmed live 2026-09-30: bumping only lastResponse still lost every bot by
        // ~tick 54 -- TIMEOUT_NO_CONNECTION's shorter 50-tick threshold was the one actually firing.
        // Bumping both here each tick is the bot-side equivalent of a real client's connection (and
        // its packets) staying alive the whole session.
        bot.lastConnected = World.currentTick;
        bot.lastResponse = World.currentTick;

        if (!bot.target && (Math.abs(bot.x - entry.homeX) > HOME_DRIFT_LIMIT || Math.abs(bot.z - entry.homeZ) > HOME_DRIFT_LIMIT)) {
            // died and respawned elsewhere, most likely -- walk back to post rather than chase it
            bot.teleport(entry.homeX, entry.homeZ, entry.level);
            continue;
        }

        const inv = bot.getInventory(INV);
        if (!inv) {
            continue;
        }

        if (bot.target) {
            entry.targetHeldTicks++;
            if (entry.targetHeldTicks >= TARGET_STICK_TICKS) {
                // genuinely sticking, not just briefly set before failing -- fast retry once idle again
                entry.seekInterval = SEEK_INTERVAL_BASE;
            }
        } else {
            entry.targetHeldTicks = 0;
        }

        const dueToSeek = !bot.target && World.currentTick >= entry.nextSeekTick;

        if (entry.kind === 'woodcutter') {
            if (inv.contains(LOGS) && inv.contains(TINDERBOX)) {
                useHeldOnHeld(bot, TINDERBOX, LOGS);
            } else if (dueToSeek) {
                const tree = findNearestLoc(bot.x, bot.z, bot.level, TREE, LOC_SEEK_RADIUS);
                if (tree) {
                    bot.setInteraction(Interaction.ENGINE, tree, CHOP_OP);
                }
                backoffSeek(entry);
            }
        } else if (entry.kind === 'fisherman') {
            if (inv.isFull) {
                // the "fishing and dropping" trope -- discard the catch, keep the gear
                inv.removeAll();
                grantFishingGear(inv);
            } else if (dueToSeek) {
                const spot = findNearestNpc(bot.x, bot.z, bot.level, FISH_SPOTS, NPC_SEEK_RADIUS);
                if (spot) {
                    bot.setInteraction(Interaction.ENGINE, spot, FISH_OP);
                }
                backoffSeek(entry);
            }
        } else if (entry.kind === 'firemaker') {
            if (!inv.contains(LOGS)) {
                inv.add(LOGS, inv.freeSlotCount);
            } else if (inv.contains(TINDERBOX)) {
                useHeldOnHeld(bot, TINDERBOX, LOGS);
            }
        } else if (entry.kind === 'goblin_fighter') {
            const hpFraction = bot.levels[PlayerStat.HITPOINTS] / bot.baseLevels[PlayerStat.HITPOINTS];
            if (entry.resting && hpFraction >= REST_RESUME_FRACTION) {
                entry.resting = false;
            } else if (!entry.resting && !bot.target && hpFraction <= REST_HP_FRACTION) {
                entry.resting = true;
            }

            if (dueToSeek) {
                const loot = findNearestObj(bot.x, bot.z, bot.level, COINS, bot.hash64, LOOT_RADIUS);
                if (loot) {
                    bot.setInteraction(Interaction.ENGINE, loot, TAKE_OP);
                } else if (!entry.resting) {
                    const goblin = findNearestNpc(bot.x, bot.z, bot.level, GOBLIN_TYPES, NPC_SEEK_RADIUS);
                    if (goblin) {
                        bot.setInteraction(Interaction.ENGINE, goblin, ATTACK_OP);
                    }
                }
                backoffSeek(entry);
            }
        }
    }
}
