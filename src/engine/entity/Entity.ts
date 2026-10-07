import { EntityLifeCycle } from '#/engine/entity/EntityLifeCycle.js';
// type-only: erased at compile time, so this doesn't create a runtime import
// cycle (PathingEntity.ts, a subclass of Entity, needs these checks but must
// not statically import Player.ts/Npc.ts -- see isPlayer()/isNpc() below).
import type Npc from '#/engine/entity/Npc.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import DoublyLinkable from '#/datastruct/DoublyLinkable.js';

export default abstract class Entity extends DoublyLinkable {
    // constructor
    level: number;
    x: number;
    z: number;
    isActive: boolean;
    readonly width: number;
    readonly length: number;
    readonly lifecycle: EntityLifeCycle;

    // runtime
    lifecycleTick: number = -1;
    lastLifecycleTick: number = -1;

    protected constructor(level: number, x: number, z: number, width: number, length: number, lifecycle: EntityLifeCycle) {
        super();
        this.level = level;
        this.x = x;
        this.z = z;
        this.width = width;
        this.length = length;
        this.lifecycle = lifecycle;
        this.isActive = false;
    }

    abstract resetEntity(respawn: boolean): void;

    isValid(_hash64?: bigint): boolean {
        return this.isActive;
    }

    isPlayer(): this is Player {
        return false;
    }

    isNpc(): this is Npc {
        return false;
    }

    setLifeCycle(tick: number): void {
        this.lifecycleTick = tick;
        this.lastLifecycleTick = World.currentTick;
    }
}
