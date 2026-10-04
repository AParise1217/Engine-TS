import ObjType from '#/cache/config/ObjType.js';
import CategoryType from '#/cache/config/CategoryType.js';
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
import { WorldStat } from '#/engine/WorldStat.js';
import Environment from '#/util/Environment.js';
import { toSafeName } from '#/util/JString.js';
import { printDebug } from '#/util/Logger.js';
import { CHARACTER_POOL, jitterOffset, pickOne, pickUnusedCharacter, type PoolCharacter, randInt, rollSlotCount } from '#/engine/BotPool.js';

// Ambient "population" bots: real headless Players (no client -- see NetworkPlayer.isClientConnected)
// driven by a tiny per-tick loop instead of packets, reusing the same setInteraction/executeScript
// paths a real click would use. No save file, no persistence -- ephemeral, recreated on each boot.
//
// Deliberately NOT covered here (each needs its own protocol research before it's worth building):
// fletching (knife+logs opens a "how many to make" chooser interface, not a fire-and-forget script
// like firemaking), alchemy (spell-cast-on-item isn't in ServerTriggerType at all -- unclear what
// packet/component drives it), agility (would need the real course's obstacle loc sequence, not
// guessed coordinates).
//
// ## Adding a new bot site
//
// Call Bots.registerBot(kind, x, z, level, targetNpc?, targetLoc?) from World.ts's
// NODE_BOTS_ENABLED block (next to the existing calls). That's it -- the site starts dormant,
// and scanActivation() wakes it (rolling a random 0..MAX_SLOTS_PER_SITE population, each slot
// drawing its own name/gender from CHARACTER_POOL in BotPool.ts) the first time a real player
// comes within ACTIVATION_RADIUS. No per-bot identity to pick; that's handled for you.
//
// ## Adding a new bot kind
//
// 1. Add the kind to the BotKind union type below.
// 2. Add a flavor-text entry to CHAT_LINES keyed by the new kind.
// 3. Add a GRANTS[newKind] = (bot, inv) => { ... } entry -- this is what equips/stocks a freshly
//    spawned bot of this kind, same shape as 'woodcutter'/'fisherman'/'firemaker'/'fighter'.
// 4. Add a branch for the new kind inside tick()'s `for (const entry of bots)` loop -- this is
//    the actual per-tick AI decision (what to seek, what to do once found/holding the right
//    item). Look at the 'woodcutter' branch for the simplest shape (seek a loc, use a held item
//    on it) or 'fighter' for the most complex (seek an NPC, loot, rest-on-low-HP hysteresis).
//
// ## Adding new pool characters
//
// Add entries to CHARACTER_POOL in BotPool.ts. Run `bun test src/engine/BotPool.test.ts`
// afterward -- it will fail loudly if a new name doesn't survive toSafeName() cleanly (empty or
// >12 chars) or collides with an existing entry after normalization.
//
// ## Extending identity/archetype variety for a kind other than 'fighter'
//
// Only 'fighter' currently rolls a warrior/ranger/mage archetype (getArchetypes()/
// equipArchetype(), below) on top of the pool-drawn name/gender. A different kind wanting its own
// archetype-style variance should follow that same pattern: a getXArchetypes() pool of
// {stats, gearPools} defs, picked once per spawn inside that kind's GRANTS entry.

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

// Player.masks & PlayerInfoProt.APPEARANCE only fires once, at spawn (equipArchetype's
// buildAppearance() call) -- before any real player is ever nearby to receive it. Confirmed live
// 2026-09-30 via a client-side decode trace: a real player who comes into view AFTER that one mask
// pulse gets a PlayerEntity shell with all-zero appearance bytes (invisible model, but combat mask
// bits like DAMAGE/ANIM still work independently, since those fire on their own each time). Forcing
// the mask again periodically means any real player standing nearby eventually gets a correct
// appearance within one interval, instead of never. Kept short (review feedback: 50 ticks = up to
// 25s invisible at the on-device 500ms tickrate) since a refresh is just a flag + a cheap byte-buffer
// regen -- negligible even at a much larger bot count than today's 6.
const APPEARANCE_REFRESH_INTERVAL = 10;

// Ambient overhead chat (Player.say(), the same primitive a CS2 script uses for ~chatplayer) --
// purely cosmetic "feels alive" flavor, no gameplay effect. Minutes apart, not seconds: real players
// don't narrate every action either, and this is one `say()` call (a mask bit + a string, same cost
// class as the appearance refresh above) so it's cheap regardless of interval -- the wide spacing is
// for believability, not performance. At the 500ms on-device tickrate, 150-400 ticks is ~75-200s.
const CHAT_INTERVAL_MIN = 150;
const CHAT_INTERVAL_MAX = 400;

// fighter is the only kind whose flavor isn't keyed by monster -- all three fighter bots share one
// pool regardless of target, so this doesn't need a per-target split.
const CHAT_LINES: Record<BotKind, string[]> = {
    woodcutter: ['Chop chop!', 'This axe could use a sharpen.', "That's a fine piece of timber.", 'Mind the splinters.', 'Nothing like fresh-cut wood.'],
    fisherman: ["They're biting today!", 'Reel it in...', 'Mind your fingers on the hooks.', 'Fresh catch, coming right up.', 'Quiet out here, just how I like it.'],
    firemaker: ['Nice and warm by this fire.', "Watch the sparks, don't want to singe anything.", "That's a good burn.", 'Keeps the cold off, at least.'],
    fighter: ['Come on then!', 'Is that all you’ve got?', "I'll take you down!", 'Ha, missed me.', 'For glory!', 'Watch yourself.']
};

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

// Game-feel placeholders, not derived from Phase 1's tick-cost baseline (that measures cost, not
// distance) -- picked relative to this file's existing seek radii (confirmed live distances: 14
// tiles to the nearest tree, 3 to the nearest goblin, both inside LOC_SEEK_RADIUS/NPC_SEEK_RADIUS's
// 18/15) so a bot is already awake and able to act by the time a real player would actually notice
// it. DEACTIVATION_RADIUS must stay strictly larger than ACTIVATION_RADIUS -- the gap is the
// hysteresis that stops a bot at the boundary from waking and sleeping every few ticks, same shape
// as REST_HP_FRACTION/REST_RESUME_FRACTION below. ponytail: retune both from Task 4's on-device feel
// check, not from Phase 1's cost data.
const ACTIVATION_RADIUS = 20;
const DEACTIVATION_RADIUS = 40;

// Load-based breaker (spec Section 3): a safety net, not the primary scaling fix -- Section 2's
// spatial activation is what keeps standing bot cost near zero. This only guards against a future
// correctness bug or an unlucky cluster of active bots degrading the tick loop, the way the two
// prior incidents (a missing seek backoff, then the single-arrow ranger) did before they were
// root-caused and fixed.
//
// Phase 1's real on-device baseline (2026-09-30-ambient-bot-scaling-phase1-metrics.md, corrected
// per that plan's own final review): 6 always-on bots cost up to 719ms/2548ms (28%) of a single
// tick in the worst observed case. 0.9 leaves normal per-tick work its usual headroom while still
// catching a bot-driven spike before it dominates the tick.
const TICK_BUDGET_FRACTION = 0.9;
// 10 consecutive over-budget ticks (5s at this hardware's default 500ms NODE_TICKRATE) before
// shedding a bot -- long enough that a single transient npc/client-out spike (Phase 2's on-device
// testing found these are the actual worst-case tick cost on this hardware, not bots -- see
// CLAUDE.md's Phase 2 notes) doesn't trigger a shed, short enough that a genuinely sustained
// bot-driven overload gets corrected within a few seconds. ponytail: retune once the spec's
// Sequencing step 4 (a full-backlog re-baseline) exists.
const OVERLOAD_TICKS_BEFORE_SHED = 10;

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
    logs: number;
    tinderbox: number;
    runeAxe: number;
    fishCategories: number[];
    net: number;
    fishingRod: number;
    feather: number;
    harpoon: number;
    lobsterPot: number;
    coins: number;
} | null = null;

function getIds() {
    if (!ids) {
        ids = {
            inv: InvType.getId('inv'),
            logs: ObjType.getId('logs'),
            tinderbox: ObjType.getId('tinderbox'),
            runeAxe: ObjType.getId('rune_axe'),
            // Fish spots are only ever registered under a shared CATEGORY (nc_category in content
            // scripts) -- there is no standalone "[saltfish]" NpcType, only per-location ones like
            // "[0_44_53_saltfish]". NpcType.getId('saltfish') always returned -1 here, which is why
            // every fisherman bot found zero spots regardless of coordinates (confirmed live via a
            // headless World.start() scan, 2026-10-02) -- not a coordinate problem at all.
            fishCategories: [CategoryType.getId('freshfish'), CategoryType.getId('saltfish'), CategoryType.getId('rarefish'), CategoryType.getId('memberfish')],
            net: ObjType.getId('net'),
            fishingRod: ObjType.getId('fishing_rod'),
            feather: ObjType.getId('feather'),
            harpoon: ObjType.getId('harpoon'),
            lobsterPot: ObjType.getId('lobster_pot'),
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

type BotKind = 'woodcutter' | 'fisherman' | 'firemaker' | 'fighter';

const MAX_SLOTS_PER_SITE = 3;
const JITTER_TILES = 2;

// Permanent record of every known bot "site" -- created once via registerBot() and never removed.
// activeCount tracks how many live Player slots currently exist for it (0..MAX_SLOTS_PER_SITE);
// scanActivation() is the only thing that changes it. targetSlotCount is the random population
// size rolled for the CURRENT visit (-1 means "no visit in progress, roll fresh on next wake").
interface BotSite {
    kind: BotKind;
    homeX: number;
    homeZ: number;
    level: number;
    // Only meaningful for kind 'fighter' -- NpcType debugnames of the monster(s) to attack (e.g.
    // ['goblin'], ['cow'], ['ardougne_guard']). Generalized off the original goblin-only fighter so
    // a new fight-bot location is just a registerBot() call, not new code.
    targetNpc: string[];
    // Only meaningful for kind 'woodcutter' -- LocType debugname of the tree species to chop (e.g.
    // 'tree', 'willowtree', 'magictree'). Generalized the same way as targetNpc above.
    targetLoc: string;
    // Tier 2's shed cooldown -- 0 means "no cooldown active". Blocks ALL refill for this site
    // (every slot, not just the one shed) until it expires, same semantic as before this task.
    shedUntilTick: number;
    activeCount: number;
    targetSlotCount: number;
}

const sites: BotSite[] = [];

// Real-vs-bot identity used to be a plain `username.startsWith('bot_')` string check -- fine as
// long as every bot login name carried that reserved prefix, but that prefix is also what made
// every ambient bot show up to a real player as "Bot Fisher1" over its head and in its right-click
// menu (toDisplayName() just title-cases the literal username -- there is no separate
// server-controlled display name, see World.ts's login flow). A plain Set, not a regex/convention,
// so a bot's name can be anything that fits RS2's 12-char base37 charset.
//
// Built once from the pool, not from site registration -- identity is drawn dynamically at spawn
// time now (see registerBot()/spawn() below), so there's no fixed per-site username to register.
const botUsernames: Set<string> = new Set(CHARACTER_POOL.map(c => toSafeName(c.name)));

export function isBotUsername(username: string): boolean {
    return botUsernames.has(username);
}

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
    nextAppearanceRefreshTick: number;
    nextChatTick: number;
    targetTypeIds: number[]; // resolved once at spawn from site.targetNpc -- only used by kind 'fighter'
    targetLocId: number; // resolved once at spawn from site.targetLoc -- only used by kind 'woodcutter'
    // Only used by kind 'fighter'. lastSeekTargetUid is the npc.uid the most recent setInteraction
    // was aimed at; avoidNpcUid is a one-shot exclusion for the NEXT seek, set when a target clears
    // before it ever "sticks" (see tick()'s held-ticks block) -- most commonly a single-combat-zone
    // rejection ("Someone else is fighting that"), not a real failure to find anything. -1 means "no
    // exclusion"/"no target tracked".
    lastSeekTargetUid: number;
    avoidNpcUid: number;
    site: BotSite;
}

const bots: Set<BotEntry> = new Set();

let consecutiveOverrunTicks = 0;
// Set fresh by scanActivation() every tick to the farthest-from-any-real-player bot that's
// staying active (i.e. not already being put to sleep this tick by the DEACTIVATION_RADIUS
// check below) -- tier 2 reuses this directly instead of a second distance pass.
let farthestActive: BotEntry | null = null;

// One grant function per BotKind instead of four separate exported spawnXBot() wrappers -- nothing
// outside this file called them individually (World.ts's boot calls were the only caller, and this
// task moves those onto registerBot()), so there's no reason to keep four public entry points open.
const GRANTS: Record<BotKind, (bot: Player, inv: Inventory) => void> = {
    // Real bug (2026-10-03): this bot has carried a tinderbox (for burning its own logs once it has
    // some -- see the woodcutter tick branch below) but never an axe, since it was first written --
    // meaning it could never chop a single log in the first place (woodcut.rs2's own axe_checker
    // proc requires an axe equipped in the weapon slot or in the inventory). A rune_axe plus a flat
    // Woodcutting 99 lets one bot chop any tree species regardless of which one it's assigned, same
    // "don't bother with per-species tuning" simplicity as the fighter archetypes' gear pools.
    woodcutter: (bot, inv) => {
        bot.setLevel(PlayerStat.WOODCUTTING, 99);
        inv.add(getIds().tinderbox, 1);
        const worn = bot.getInventory(InvType.WORN);
        if (worn) {
            worn.set(3, { id: getIds().runeAxe, count: 1 });
            bot.buildAppearance(InvType.WORN);
        } else {
            inv.add(getIds().runeAxe, 1);
        }
    },
    fisherman: (_bot, inv) => grantFishingGear(inv),
    // ponytail: no real bank interaction -- just tops the logs back up directly when it runs out,
    // standing in for "walked to the bank and withdrew more". Upgrade to a real OpLoc bank
    // withdrawal if the bot should ever look like it's actually banking.
    firemaker: (_bot, inv) => {
        inv.add(getIds().tinderbox, 1);
        inv.add(getIds().logs, inv.freeSlotCount);
    },
    fighter: bot => {
        const pool = getArchetypes();
        const archetype = pickOne(Object.keys(pool) as Archetype[]);
        equipArchetype(bot, pool[archetype]);
    }
};

function spawn(site: BotSite, character: PoolCharacter): void {
    const safeName = toSafeName(character.name);
    const bot = PlayerLoading.load(safeName, new Packet(new Uint8Array(0)), null);
    const homeX = site.homeX + jitterOffset(JITTER_TILES);
    const homeZ = site.homeZ + jitterOffset(JITTER_TILES);
    bot.x = homeX;
    bot.z = homeZ;
    bot.level = site.level;
    bot.gender = character.gender;
    bot.buildAppearance(bot.appearanceInv);

    const inv = bot.getInventory(getIds().inv);
    if (inv) {
        GRANTS[site.kind](bot, inv);
    }

    // stagger first seek (and first appearance refresh, and first chat line) so a large bot
    // population doesn't all scan -- or all re-encode their appearance, or all talk at once -- on
    // the same tick.
    const nextSeekTick = Math.floor(Math.random() * SEEK_INTERVAL_BASE);
    const nextAppearanceRefreshTick = Math.floor(Math.random() * APPEARANCE_REFRESH_INTERVAL);
    const nextChatTick = World.currentTick + randInt(CHAT_INTERVAL_MIN, CHAT_INTERVAL_MAX);
    bots.add({
        player: bot,
        kind: site.kind,
        homeX,
        homeZ,
        level: site.level,
        nextSeekTick,
        seekInterval: SEEK_INTERVAL_BASE,
        resting: false,
        targetHeldTicks: 0,
        nextAppearanceRefreshTick,
        nextChatTick,
        targetTypeIds: site.targetNpc.map(name => NpcType.getId(name)),
        targetLocId: LocType.getId(site.targetLoc),
        lastSeekTargetUid: -1,
        avoidNpcUid: -1,
        site
    });
    World.newPlayers.add(bot);
    site.activeCount++;
}

// Call once per tick a seek is actually attempted (i.e. the bot had no target and was due).
// Backs off further every time -- reset happens separately, wherever bot.target is seen set.
function backoffSeek(entry: BotEntry): void {
    entry.nextSeekTick = World.currentTick + entry.seekInterval;
    entry.seekInterval = Math.min(entry.seekInterval * 2, SEEK_INTERVAL_MAX);
}

// Registers a bot "site" with zero active slots -- scanActivation() rolls a random population
// (0..MAX_SLOTS_PER_SITE) and spawns/despawns/refills it based on a real player's distance from
// homeX/homeZ. Each spawned slot draws its own name/gender from CHARACTER_POOL and a small
// position jitter from the site's anchor -- see spawn().
export function registerBot(kind: BotKind, x: number, z: number, level: number, targetNpc: string[] = [], targetLoc: string = 'tree'): void {
    sites.push({ kind, homeX: x, homeZ: z, level, targetNpc, targetLoc, shedUntilTick: 0, activeCount: 0, targetSlotCount: -1 });
}

function chebyshevOrInfinity(x1: number, z1: number, level1: number, x2: number, z2: number, level2: number): number {
    if (level1 !== level2) {
        // different floor -- never "near" regardless of how close x/z happen to be (e.g. a bridge
        // or staircase tile directly above a ground-floor bot's home).
        return Infinity;
    }
    return Math.max(Math.abs(x1 - x2), Math.abs(z1 - z2));
}

// Runs once per tick, before any per-bot AI logic. O(real players x sites) pure arithmetic --
// no zone traversal, no pathfinding -- cheap enough to always run, even at a much larger defined
// site count than today's 14.
function scanActivation(): void {
    const realPlayers: { x: number; z: number; level: number }[] = [];
    // Everyone (real or bot) currently live, plus anyone mid-logout -- the set of usernames a
    // freshly-picked pool character must NOT collide with. A player removed via
    // World.removePlayer() leaves playerLoop immediately but stays in World.logoutRequests until
    // the login thread confirms the save; that window is exactly "a name just freed up, but its
    // save isn't done yet" (final review of Phase 2, 2026-09-30, found the process actually goes
    // through it for real players -- the same risk applies to a bot slot mid-shed/mid-death).
    const takenUsernames: Set<string> = new Set();

    for (const player of World.playerLoop.all()) {
        takenUsernames.add(player.username);
        if (!botUsernames.has(player.username)) {
            realPlayers.push({ x: player.x, z: player.z, level: player.level });
        }
    }
    for (const pending of World.logoutRequests.keys()) {
        takenUsernames.add(pending);
    }

    for (const site of sites) {
        if (World.currentTick < site.shedUntilTick) {
            continue;
        }

        let nearbyPlayer = false;
        for (const player of realPlayers) {
            if (chebyshevOrInfinity(player.x, player.z, player.level, site.homeX, site.homeZ, site.level) <= ACTIVATION_RADIUS) {
                nearbyPlayer = true;
                break;
            }
        }
        if (!nearbyPlayer) {
            // A visit that rolled 0 (see below) never spawns a BotEntry, so tick()'s own
            // loggingOut cleanup -- the usual place targetSlotCount resets to -1 -- never runs
            // for it. Without this, a site unlucky enough to roll 0 on its first wake would stay
            // rolled at 0 forever, even across later visits, since nothing else ever resets it
            // (confirmed live 2026-10-04: a market-guard site stayed empty for 5+ minutes
            // straight). Catching it here, once the visit itself has ended, covers that case
            // without double-resetting a site that still has live bots mid-deactivation.
            if (site.activeCount === 0) {
                site.targetSlotCount = -1;
            }
            continue;
        }

        // Roll once per visit -- the moment activeCount drops back to 0 (tick()'s loggingOut
        // cleanup, or the deactivation pass below), targetSlotCount resets to -1 so the NEXT
        // visit gets its own fresh roll instead of reusing this one.
        if (site.targetSlotCount === -1) {
            site.targetSlotCount = rollSlotCount(MAX_SLOTS_PER_SITE);
        }

        while (site.activeCount < site.targetSlotCount) {
            const character = pickUnusedCharacter(CHARACTER_POOL, takenUsernames);
            if (!character) {
                break; // pool exhausted near this cluster -- retry next tick, not an error
            }
            takenUsernames.add(toSafeName(character.name));
            spawn(site, character);
        }
    }

    farthestActive = null;
    let farthestDist = -1;
    for (const entry of bots) {
        if (entry.player.loggingOut) {
            continue; // already leaving
        }
        let nearestReal = Infinity;
        for (const player of realPlayers) {
            nearestReal = Math.min(nearestReal, chebyshevOrInfinity(player.x, player.z, player.level, entry.homeX, entry.homeZ, entry.level));
        }
        if (nearestReal > DEACTIVATION_RADIUS) {
            entry.player.loggingOut = true;
            // activeCount/targetSlotCount bookkeeping happens centrally in tick()'s own
            // loggingOut cleanup branch (Task 5) -- every path that ends a bot's life (sleep,
            // death, Tier-2 shed) goes through that one place.
        } else if (nearestReal > farthestDist) {
            // stays active this tick -- Tier 2's own candidate to shed, if it ever comes to that.
            farthestDist = nearestReal;
            farthestActive = entry;
        }
    }
}

// "Total" is now capacity (every site at its max), not a 1:1 site:bot count -- each site can hold
// up to MAX_SLOTS_PER_SITE bots, not exactly one.
export function getTotalBotCount(): number {
    return sites.length * MAX_SLOTS_PER_SITE;
}

export function getDormantBotCount(): number {
    return getTotalBotCount() - bots.size;
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

// excludeUid skips one specific npc instance (Npc.uid, stable for its lifetime) -- used to avoid
// immediately re-picking an npc that just rejected an attack (e.g. "Someone else is fighting
// that"), rather than failing against the same contested target over and over while a real,
// unengaged one of the same type might be only slightly farther away.
function findNearestNpc(x: number, z: number, level: number, typeIds: number[], radius: number, excludeUid = -1) {
    let best = null;
    let bestDist = Infinity;

    for (let dx = -radius; dx <= radius; dx += 8) {
        for (let dz = -radius; dz <= radius; dz += 8) {
            for (const npc of World.gameMap.getZone(x + dx, z + dz, level).getAllNpcsSafe(true)) {
                if (!typeIds.includes(npc.type) || npc.uid === excludeUid) {
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

// Fish spots only expose their kind via a shared CATEGORY (see getIds()'s fishCategories comment),
// not their own NpcType id -- otherwise identical to findNearestNpc.
function findNearestNpcByCategory(x: number, z: number, level: number, categoryIds: number[], radius: number) {
    let best = null;
    let bestDist = Infinity;

    for (let dx = -radius; dx <= radius; dx += 8) {
        for (let dz = -radius; dz <= radius; dz += 8) {
            for (const npc of World.gameMap.getZone(x + dx, z + dz, level).getAllNpcsSafe(true)) {
                if (!categoryIds.includes(NpcType.get(npc.type).category)) {
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

export function getActiveBotCount(): number {
    return bots.size;
}

export function tick(): void {
    scanActivation();

    // lastCycleStats is the PREVIOUS tick's finished total -- this tick's own cycleStats[CYCLE]
    // isn't set until the very end of World.cycle(), well after Bots.tick() runs. Tick 0 is
    // naturally safe: lastCycleStats starts at 0, never over budget.
    const overBudget = World.lastCycleStats[WorldStat.CYCLE] > Environment.NODE_TICKRATE * TICK_BUDGET_FRACTION;
    if (overBudget) {
        consecutiveOverrunTicks++;
        if (consecutiveOverrunTicks >= OVERLOAD_TICKS_BEFORE_SHED && farthestActive) {
            if (Environment.NODE_DEBUG_PROFILE) {
                printDebug(`bot breaker: shedding ${farthestActive.player.username} after ${consecutiveOverrunTicks} consecutive over-budget ticks (tick ${World.currentTick})`);
            }
            farthestActive.player.loggingOut = true;
            // activeCount/targetSlotCount bookkeeping happens in tick()'s own loggingOut cleanup
            // branch (above) -- shedding one slot of a multi-slot site is otherwise identical to
            // that slot's bot dying.
            //
            // Blocks scanActivation()'s whole-site refill until this many ticks pass -- without
            // it, the shed bot's own logout completing (usually within a tick or two) immediately
            // re-satisfies ACTIVATION_RADIUS and undoes the shed (final review, 2026-09-30, carried
            // forward from the single-slot design).
            farthestActive.site.shedUntilTick = World.currentTick + OVERLOAD_TICKS_BEFORE_SHED;
            farthestActive = null;
            // Give the shed a full window to take effect (or reveal the overload isn't
            // bot-driven at all) before considering shedding a second bot.
            consecutiveOverrunTicks = 0;
        }
    } else {
        consecutiveOverrunTicks = 0;
    }

    const { inv: INV, logs: LOGS, tinderbox: TINDERBOX, fishCategories: FISH_CATEGORIES, coins: COINS } = getIds();

    for (const entry of bots) {
        const bot = entry.player;
        if (bot.loggingOut) {
            // Not just scanActivation()'s own sleep decision -- a bot can also leave via
            // TIMEOUT_NO_RESPONSE/TIMEOUT_NO_CONNECTION, death (below), or a Tier-2 shed, none of
            // which otherwise touch entry.site. This is the one place that bookkeeping happens,
            // for every way a bot's life can end.
            entry.site.activeCount--;
            if (entry.site.activeCount === 0) {
                entry.site.targetSlotCount = -1; // needs a fresh roll on this site's next wake
            }
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

        if (World.currentTick >= entry.nextAppearanceRefreshTick) {
            bot.buildAppearance(bot.appearanceInv);
            entry.nextAppearanceRefreshTick = World.currentTick + APPEARANCE_REFRESH_INTERVAL;
        }

        if (World.currentTick >= entry.nextChatTick) {
            bot.say(pickOne(CHAT_LINES[entry.kind]));
            entry.nextChatTick = World.currentTick + randInt(CHAT_INTERVAL_MIN, CHAT_INTERVAL_MAX);
        }

        if (!bot.target && (Math.abs(bot.x - entry.homeX) > HOME_DRIFT_LIMIT || Math.abs(bot.z - entry.homeZ) > HOME_DRIFT_LIMIT)) {
            // Died and respawned elsewhere, most likely. There is no death/respawn event in this
            // engine -- GRANTS/equipArchetype only ever ran once, at this entity's original
            // spawn() -- so teleporting the SAME (now-bare) entity home just leaves it
            // permanently ungeared after its first death (the root cause of the reported "stall
            // guard always a bare warrior" bug). Logging it out instead frees this site's slot;
            // the unified wake/refill rule in scanActivation() replaces it next tick with a
            // freshly-rolled pool character -- new name, new archetype, new gear -- as long as a
            // real player is still nearby.
            bot.loggingOut = true;
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
            // Cleared before it ever stuck (0 < held < TARGET_STICK_TICKS) -- for a fighter, this
            // is almost always a single-combat-zone rejection ("Someone else is fighting that"),
            // not a real pathing failure. Avoid that exact npc on the very next seek instead of
            // immediately re-picking the same contested target and failing again.
            if (entry.targetHeldTicks > 0 && entry.targetHeldTicks < TARGET_STICK_TICKS && entry.lastSeekTargetUid !== -1) {
                entry.avoidNpcUid = entry.lastSeekTargetUid;
            }
            entry.targetHeldTicks = 0;
            entry.lastSeekTargetUid = -1;
        }

        const dueToSeek = !bot.target && World.currentTick >= entry.nextSeekTick;

        if (overBudget) {
            // Tier 1: skip only this tick's per-bot-kind AI action logic. Lifecycle bookkeeping
            // above (logout cleanup, connection keepalive, appearance refresh, home-drift
            // teleport) still runs every tick regardless -- an active bot mid-interaction is
            // ordinary processPlayers() work this function doesn't control either way.
            if (dueToSeek) {
                // Without this, nextSeekTick stays in the past for the entire skipped stretch,
                // so the FIRST under-budget tick has every targetless active bot seek at once --
                // exactly the thundering-herd scan this same stagger already exists to prevent at
                // spawn time (see the comment on nextSeekTick in spawn()). Final review
                // (2026-09-30): re-stagger on recovery the same way.
                entry.nextSeekTick = World.currentTick + 1 + Math.floor(Math.random() * SEEK_INTERVAL_BASE);
            }
            continue;
        }

        if (entry.kind === 'woodcutter') {
            if (inv.contains(LOGS) && inv.contains(TINDERBOX)) {
                useHeldOnHeld(bot, TINDERBOX, LOGS);
            } else if (dueToSeek) {
                const tree = findNearestLoc(bot.x, bot.z, bot.level, entry.targetLocId, LOC_SEEK_RADIUS);
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
                const spot = findNearestNpcByCategory(bot.x, bot.z, bot.level, FISH_CATEGORIES, NPC_SEEK_RADIUS);
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
        } else if (entry.kind === 'fighter') {
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
                    const target = findNearestNpc(bot.x, bot.z, bot.level, entry.targetTypeIds, NPC_SEEK_RADIUS, entry.avoidNpcUid);
                    entry.avoidNpcUid = -1; // one-shot -- consumed by this attempt regardless of outcome
                    if (target) {
                        bot.setInteraction(Interaction.ENGINE, target, ATTACK_OP);
                        entry.lastSeekTargetUid = target.uid;
                    }
                }
                backoffSeek(entry);
            }
        }
    }
}
