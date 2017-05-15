import {Operation} from "./Operation";
import {EmergencyMinerMission} from "../missions/EmergencyMission";
import {RefillMission} from "../missions/RefillMission";
import {PowerMission} from "../missions/PowerMission";
import {TerminalNetworkMission} from "../missions/TerminalNetworkMission";
import {IgorMission} from "../missions/IgorMission";
import {LinkMiningMission} from "../missions/LinkMiningMission";
import {MiningMission} from "../missions/MiningMission";
import {BuilderMission} from "../missions/BuilderMission";
import {LinkNetworkMission} from "../missions/LinkNetworkMission";
import {GeologyMission} from "../missions/GeologyMission";
import {UpgradeMission} from "../missions/UpgradeMission";
import {Coord, SeedData} from "../../interfaces";
import {helper} from "../../helpers/helper";
import {SeedAnalysis} from "../SeedAnalysis";
import {SpawnGroup} from "../SpawnGroup";
import {Empire, empire} from "../Empire";
import {MasonMission} from "../missions/MasonMission";
import {OperationPriority} from "../../config/constants";
import {BodyguardMission} from "../missions/BodyguardMission";
import {RemoteBuildMission} from "../missions/RemoteBuildMission";
import {ScoutMission} from "../missions/ScoutMission";
import {ClaimMission} from "../missions/ClaimMission";
import {SurveyMission} from "../missions/SurveyMission";
import {DefenseMission} from "../missions/DefenseMission";
import {DefenseGuru} from "../DefenseGuru";
import {Scheduler} from "../../Scheduler";
import {PaverMission} from "../missions/PaverMission";

export abstract class ControllerOperation extends Operation {

    constructor(flag: Flag, name: string, type: string) {
        super(flag, name, type);
        this.priority = OperationPriority.OwnedRoom;
        if (this.flag.room && this.flag.room.controller.level < 6) {
            this.priority = OperationPriority.VeryHigh;
        }
    }

    public memory: {
        powerMining: boolean
        noMason: boolean
        masonPotency: number
        builderPotency: number
        wallBoost: boolean
        mason: { activateBoost: boolean }
        network: { scanData: { roomNames: string[]} }
        centerPosition: RoomPosition;
        centerPoint: Coord;
        rotation: number
        repairIndices: {[structureType: string]: number}
        temporaryPlacement: {[level: number]: boolean}
        checkLayoutIndex: number
        layoutMap: {[structureType: string]: Coord[]}
        radius: number
        nextCheck: {[structureType: string]: number }
        spawnRooms: string[]

        // deprecated values
        flexLayoutMap: {[structureType: string]: Coord[]}
        flexRadius: number
    };

    protected staticStructures: {[structureType: string]: Coord[]};

    protected abstract initAutoLayout();
    protected abstract temporaryPlacement(controllerLevel: number);

    public initOperation() {
        let layoutSuccessful = this.autoLayout();
        if (!layoutSuccessful) {
            console.log(`${this.name} is unable to operate, layout parameters have not been set`);
            return;
        }

        this.spawnGroup = empire.getSpawnGroup(this.flag.pos.roomName);
        this.initRemoteSpawn(8, 8);

        let remoteSpawning = false;
        if (!this.spawnGroup) {
            remoteSpawning = true;

            if (!this.remoteSpawn) {
                console.log(`${this.name} is unable to spawn, no local or remote spawnGroup`);
                return;
            }

            this.spawnGroup = this.remoteSpawn.spawnGroup;
            this.addMission(new ScoutMission(this));
            this.addMission(new ClaimMission(this));
            if (!this.hasVision || this.room.controller.level === 0) { return; } // vision can be assumed after this
        }

        this.addMission(new RemoteBuildMission(this, false, remoteSpawning));
        if (this.room.controller.level < 3 && this.room.findStructures(STRUCTURE_TOWER).length === 0) {
            if (this.remoteSpawn.spawnGroup && this.remoteSpawn.spawnGroup.room.controller.level === 8) {
                let bodyguard = new BodyguardMission(this);
                bodyguard.spawnGroup = this.remoteSpawn.spawnGroup;
                this.addMission(bodyguard);
            }
        }

        if (this.flag.room.findStructures(STRUCTURE_SPAWN).length > 0) {
            // spawn emergency miner if needed
            this.addMission(new EmergencyMinerMission(this));
            // refill spawning energy - will spawn small spawnCart if needed
            this.addMission(new RefillMission(this));
        }

        let defenseGuru = new DefenseGuru(this);
        this.addMission(new DefenseMission(this));
        this.addMission(new PowerMission(this));

        // energy network
        if (this.flag.room.terminal && this.flag.room.storage && this.flag.room.controller.level >= 6) {
            this.addMission(new TerminalNetworkMission(this));
            this.addMission(new IgorMission(this));
        }

        // harvest energy
        MiningMission.Add(this, true);

        // build construction
        let buildMission = new BuilderMission(this, defenseGuru);
        this.addMission(buildMission);

        if (this.flag.room.storage) {
            // use link array near storage to fire energy at controller link (pre-rcl8)
            this.addMission(new LinkNetworkMission(this));
            // mine minerals
            this.addMission(new GeologyMission(this));
            // scout and place harvest flags
            this.addMission(new SurveyMission(this));
            // repair walls
            this.addMission(new MasonMission(this, defenseGuru));
        }

        // upgrader controller
        let boostUpgraders = this.flag.room.controller.level < 8;
        let upgradeMission = new UpgradeMission(this, boostUpgraders);
        this.addMission(upgradeMission);

        // upkeep roads and walls
        this.towerRepair();

        this.addMission(new PaverMission(this, defenseGuru.hostiles.length > 0));
    }

    public finalizeOperation() {
    }

    public invalidateOperationCache() {
    }

    public nuke(x: number, y: number, roomName: string): string {
        let nuker = _.head(this.flag.room.find(FIND_MY_STRUCTURES,
            {filter: {structureType: STRUCTURE_NUKER}})) as StructureNuker;
        let outcome = nuker.launchNuke(new RoomPosition(x, y, roomName));
        if (outcome === OK) {
            empire.map.addNuke({tick: Game.time, roomName: roomName});
            return "NUKER: Bombs away! \\o/";
        } else {
            return `NUKER: error: ${outcome}`;
        }
    }

    public moveLayout(x: number, y: number, rotation: number): string {
        this.memory.centerPosition = new RoomPosition(x, y, this.flag.pos.roomName);
        this.memory.rotation = rotation;
        this.memory.layoutMap = undefined;
        this.showLayout(false);

        return `moving layout, run command ${this.name}.showLayout(true) to display`;
    }

    public showLayout(show: boolean, type = "all"): string {
        if (!this.memory.rotation === undefined || !this.memory.centerPosition) {
            return "No layout defined";
        }

        if (!show) {
            for (let flagName in Game.flags) {
                let flag = Game.flags[flagName];
                if (flag.name.indexOf(`${this.name}_layout`) >= 0) { flag.remove(); }}
            return "removing layout flags";
        }

        for (let structureType of Object.keys(CONSTRUCTION_COST)) {
            if (type === "all" || type === structureType ) {
                let coords = this.layoutCoords(structureType);
                let order = 0;
                for (let coord of coords) {
                    let flagName = `${this.name}_layout_${structureType}_${order++}`;
                    let flag = Game.flags[flagName];
                    if (flag) {
                        flag.setPosition(coord.x, coord.y);
                        continue;
                    }

                    let position = helper.coordToPosition(coord, this.memory.centerPosition, this.memory.rotation);
                    let color = COLOR_WHITE;
                    if (structureType === STRUCTURE_EXTENSION || structureType === STRUCTURE_SPAWN
                        || structureType === STRUCTURE_STORAGE || structureType === STRUCTURE_NUKER) {
                        color = COLOR_YELLOW;
                    } else if (structureType === STRUCTURE_TOWER) {
                        color = COLOR_BLUE;
                    } else if (structureType === STRUCTURE_LAB || structureType === STRUCTURE_TERMINAL) {
                        color = COLOR_CYAN;
                    } else if (structureType === STRUCTURE_POWER_SPAWN) {
                        color = COLOR_RED;
                    } else if (structureType === STRUCTURE_OBSERVER) {
                        color = COLOR_BROWN;
                    } else if (structureType === STRUCTURE_ROAD) {
                        color = COLOR_GREY;
                    } else if (structureType === STRUCTURE_RAMPART) {
                        color = COLOR_GREEN;
                    }
                    position.createFlag(flagName, color);
                }
            }
        }

        return `showing layout flags for: ${type}`;
    }

    private autoLayout(): boolean {

        this.initWithSpawn();
        if (!this.memory.centerPosition || this.memory.rotation === undefined ) { return false; }
        this.initAutoLayout();
        this.buildLayout();
        return true;
    }

    private buildLayout() {

        if (!this.flag.room) { return; }
        let structureTypes = Object.keys(CONSTRUCTION_COST);
        if (this.memory.checkLayoutIndex === undefined || this.memory.checkLayoutIndex >= structureTypes.length) {
            this.memory.checkLayoutIndex = 0;
        }
        let structureType = structureTypes[this.memory.checkLayoutIndex++];

        this.fixedPlacement(structureType);
        this.temporaryPlacement(this.flag.room.controller.level);
    }

    private fixedPlacement(structureType: string) {
        let controllerLevel = this.flag.room.controller.level;
        let constructionPriority = Math.max(controllerLevel * 10, 40);
        if (controllerLevel === 1) {
            constructionPriority = 90;
        }
        if (Object.keys(Game.constructionSites).length > constructionPriority) { return; }
        if (structureType === STRUCTURE_RAMPART && controllerLevel < 5) { return; }
        if (!this.memory.nextCheck) { this.memory.nextCheck = {}; }
        if (Game.time < this.memory.nextCheck[structureType]) { return; }

        let coords = this.layoutCoords(structureType);
        let allowedCount = this.allowedCount(structureType, controllerLevel);

        for (let i = 0; i < coords.length; i++) {
            if (i >= allowedCount) { break; }

            let coord = coords[i];
            let position = helper.coordToPosition(coord, this.memory.centerPosition, this.memory.rotation);
            let structure = position.lookForStructure(structureType);
            if (structure) {
                this.repairLayout(structure);
                continue;
            }
            let hasConstruction = position.lookFor(LOOK_CONSTRUCTION_SITES)[0];
            if (hasConstruction) { continue; }

            let outcome = position.createConstructionSite(structureType);
            if (outcome === OK) {
                console.log(`LAYOUT: placing ${structureType} at ${position} (${this.name})`);
            } else {
                console.log(`LAYOUT: error: ${outcome}, ${structureType}, ${position} (${this.name})`);
            }

            return;
        }

        this.memory.nextCheck[structureType] = Game.time + helper.randomInterval(1000);
    }

    private recalculateLayout(layoutType?: string) {

        let sourceData = [];
        for (let source of this.flag.room.find<Source>(FIND_SOURCES)) {
            sourceData.push({pos: source.pos, amount: 3000 });
        }
        let seedData = {
            sourceData: sourceData,
            seedScan: {},
            seedSelectData: undefined,
        };

        let analysis = new SeedAnalysis(this.flag.room, seedData);
        let results = analysis.run(this.staticStructures, layoutType);
        if (results) {
            let centerPosition = new RoomPosition(results.origin.x, results.origin.y, this.flag.room.name);
            if (results.seedType === this.type) {
                console.log(`${this.name} found best seed of type ${results.seedType}, initiating auto-layout`);
                this.memory.centerPosition = centerPosition;
                this.memory.rotation = results.rotation;
            } else {
                console.log(`${this.name} found best seed of another type, replacing operation`);
                let flagName = `${results.seedType}_${this.name}`;
                Memory.flags[flagName] = { centerPosition: centerPosition, rotation: results.rotation };
                this.flag.pos.createFlag(flagName, COLOR_GREY);
                this.flag.remove();
            }
        } else {
            console.log(`${this.name} could not find a suitable auto-layout, consider using another spawn location or` +
                ` room`);
        }
    }

    protected allowedCount(structureType: string, level: number): number {
        if (this.name === "bonn0" && (structureType === STRUCTURE_EXTENSION || structureType === STRUCTURE_ROAD
            || structureType === STRUCTURE_OBSERVER)) {
            // hack due to war, will break normal behavior
            return 0;
        }

        if (structureType === STRUCTURE_EXTENSION &&
            (this.room.hostiles.length > 0 || this.room.find<Nuke>(FIND_NUKES).length > 0)) {
            // don't build extensions while hostiles are in the room
            // sometimes extensions need to be destroyed to make room for hazmat
            return 0;
        }

        if (level < 5 && (structureType === STRUCTURE_RAMPART || structureType === STRUCTURE_WALL
            || structureType === STRUCTURE_ROAD)) {
            return 0;
        }

        return Math.min(CONTROLLER_STRUCTURES[structureType][level], this.layoutCoords(structureType).length);
    }

    protected layoutCoords(structureType: string): Coord[] {
        if (this.staticStructures[structureType]) {
            return this.staticStructures[structureType];
        } else if (this.memory.layoutMap && this.memory.layoutMap[structureType]) {
            return this.memory.layoutMap[structureType];
        } else {
            return [];
        }
    }

    private initWithSpawn() {

        if (!this.flag.room) { return; }
        if (!this.memory.centerPosition || this.memory.rotation === undefined) {
            let structureCount = this.flag.room.find(FIND_STRUCTURES).length;
            if (structureCount === 1) {
                this.recalculateLayout();
            } else if (structureCount > 1) {
                this.recalculateLayout(this.type);
            }
            return;
        }
    }

    protected towerRepair() {

        if (this.flag.room.hostiles.length > 0) { return; }

        let structureType = STRUCTURE_RAMPART;
        if (Game.time % 2 === 0) {
            structureType = STRUCTURE_ROAD;
        }

        let coords = this.layoutCoords(structureType);
        if (!this.memory.repairIndices) { this.memory.repairIndices = {}; }
        if (this.memory.repairIndices[structureType] === undefined ||
            this.memory.repairIndices[structureType] >= coords.length) {
            this.memory.repairIndices[structureType] = 0;
        }

        let coord = coords[this.memory.repairIndices[structureType]++];
        let position = helper.coordToPosition(coord, this.memory.centerPosition, this.memory.rotation);
        let structure = position.lookForStructure(structureType);
        if (structure) {
            this.repairLayout(structure);
        }
    }

    // deprecated
    private findRemoteSpawn(distanceLimit: number, levelRequirement = 8): SpawnGroup {
        let remoteSpawn = _(empire.spawnGroups)
            .filter((s: SpawnGroup) => {
                return Game.map.getRoomLinearDistance(this.flag.pos.roomName, s.room.name) <= distanceLimit
                    && s.room.controller.level >= levelRequirement
                    && s.averageAvailability > .3
                    && s.isAvailable;
            })
            .sortBy((s: SpawnGroup) => {
                return Game.map.getRoomLinearDistance(this.flag.pos.roomName, s.room.name);
            })
            .head();
        return remoteSpawn;
    }

    private repairLayout(structure: Structure) {

        let repairsNeeded = Math.floor((structure.hitsMax - structure.hits) / 800);
        if (structure.structureType === STRUCTURE_RAMPART) {
            if (structure.hits >= 100000) { return; }
        } else {
            if (repairsNeeded === 0) { return; }
        }

        let towers = this.flag.room.findStructures<StructureTower>(STRUCTURE_TOWER);

        for (let tower of towers) {
            if (repairsNeeded === 0) { return; }
            if (tower.alreadyFired) { continue; }
            if (!tower.pos.inRangeTo(structure, Math.max(5, this.memory.radius - 3))) { continue; }
            let outcome = tower.repair(structure);
            repairsNeeded--;
        }

        if (repairsNeeded > 0 && towers.length > 0) {
            structure.pos.findClosestByRange<StructureTower>(towers).repair(structure);
        }
    }
}
