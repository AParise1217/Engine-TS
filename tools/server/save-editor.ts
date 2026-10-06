// Shared helper for one-off scripts that read/mutate a player .sav file directly
// (e.g. dev-character fixups) without booting the full server.
//
// Why this exists: Player's constructor sizes several fields off cache config
// counts that are 0 until that config is loaded -- most dangerously
// `this.vars = new Int32Array(VarPlayerType.count)` in Player.ts. Int32Array
// writes past its fixed length are silently dropped (it doesn't grow), so a
// script that forgets to load VarPlayerType doesn't throw: it just discards
// every varp during load, then on save() writes varpCount=0, wiping every
// quest/setting/progress flag the character had. This happened for real on
// 2026-10-06 (see docs/decisions/0010-save-file-editing-safety.md) from a
// script that loaded ObjType/InvType but not VarPlayerType.
//
// loadAllConfigs() below loads the exact same set World.reload() does, so a
// script that calls it can't partially load caches by omission. assertConfigsLoaded()
// fails loudly (instead of silently truncating) if anything is still unloaded.
import fs from 'fs';
import path from 'path';

import CategoryType from '#/cache/config/CategoryType.js';
import EnumType from '#/cache/config/EnumType.js';
import IdkType from '#/cache/config/IdkType.js';
import InvType from '#/cache/config/InvType.js';
import LocType from '#/cache/config/LocType.js';
import NpcType from '#/cache/config/NpcType.js';
import ObjType from '#/cache/config/ObjType.js';
import ParamType from '#/cache/config/ParamType.js';
import SeqFrame from '#/cache/config/SeqFrame.js';
import SeqType from '#/cache/config/SeqType.js';
import SpotanimType from '#/cache/config/SpotanimType.js';
import StructType from '#/cache/config/StructType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';

import Player from '#/engine/entity/Player.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';

export function loadAllConfigs(dir = 'data/pack'): void {
    VarPlayerType.load(dir);
    ParamType.load(dir);
    ObjType.load(dir);
    LocType.load(dir);
    NpcType.load(dir);
    IdkType.load(dir);
    SeqFrame.load(dir);
    SeqType.load(dir);
    SpotanimType.load(dir);
    CategoryType.load(dir);
    EnumType.load(dir);
    StructType.load(dir);
    InvType.load(dir);

    assertConfigsLoaded();
}

// Catches "forgot to call loadAllConfigs()" or "called it before this import
// ran" immediately and loudly, instead of letting Player silently size an
// Int32Array/array to 0 and corrupt whatever gets saved later.
export function assertConfigsLoaded(): void {
    const counts: [string, number][] = [
        ['VarPlayerType', VarPlayerType.count],
        ['ObjType', ObjType.count],
        ['InvType', InvType.count],
        ['LocType', LocType.count],
        ['NpcType', NpcType.count],
    ];

    for (const [name, count] of counts) {
        if (count <= 0) {
            throw new Error(`${name}.count is ${count} -- call loadAllConfigs() before touching any Player save (see tools/server/save-editor.ts header).`);
        }
    }
}

export function loadSave(savePath: string, name: string): Player {
    assertConfigsLoaded();
    const bytes = fs.readFileSync(savePath);
    return PlayerLoading.load(name, new Packet(new Uint8Array(bytes)), null);
}

// Always backs up the existing file (timestamped, next to the original)
// before overwriting it. Never deletes old backups -- disk is cheap, a lost
// save is not.
export function writeSave(savePath: string, player: Player): string {
    assertConfigsLoaded();

    if (fs.existsSync(savePath)) {
        const backupPath = `${savePath}.bak-${Date.now()}`;
        fs.copyFileSync(savePath, backupPath);
        console.log(`backed up ${savePath} -> ${backupPath}`);
    } else {
        console.log(`warning: ${savePath} does not exist yet, writing a fresh save`);
    }

    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, player.save());
    console.log(`wrote ${savePath}`);

    return savePath;
}

export function warnIfServerMightBeRunning(): void {
    console.warn(
        '\n[save-editor] Before writing: make sure the character this save belongs to is logged OUT of any running dev server.\n' +
        "If it's still connected, the server holds its own in-memory copy and will silently overwrite this edit on its next autosave/logout.\n"
    );
}
