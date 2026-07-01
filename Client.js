"use strict";

const { Client, createClient } = require("../protocol/index.js");
const { v3, v4fast: v4 } = require("uuid-1345");
const { Authflow } = require("../authentication/index.js");

const fs = require("fs");
const JWT = require("jsonwebtoken");

const {
    getCacheFactory,
    generateRandomString,
    deviceMapping,
    cleanLeftovers,
    getInputMode,
    getDeviceId,
    translateDisconnectMessage
} = require("./Util.js");

const RealmAPI = require("./Realm.js");
const input_data = require("../ext/input_data.json");
const verData = require("../ext/data.json");
const config = require("../ext/config.json");

let cmdOriginUUID = v4();

const ConcurrentRealms = [];
const ConcurrentUsers = new Map();

const skins = {};
skins["steve"] = JSON.parse(fs.readFileSync(`./ext/steve.json`, "utf8"));
skins["clg"] = JSON.parse(fs.readFileSync(`./ext/clg.json`, "utf8"));

Client.prototype.tick = 0n;
Client.prototype.tick1 = 0n;
Client.prototype.tick2 = 0n;
Client.prototype.tick3 = 0n;

Client.prototype.move = function (position = { x: 0, y: 0, z: 0 }, num = 0) {
    if (typeof position != "object") return;

    let packetName = `player_auth_input_${num}`;

    if (num === 0) packetName = 'player_auth_input';

    /*tsl -
        Android Logged Times for Packet:
            63 ms
            47 ms
            31 ms
    */

    let data = {
        position: {
            x: position.x,
            y: position.y,
            z: position.z
        },
        move_vector: { x: 0, z: 0 },
        analogue_move_vector: { x: 0, z: 0 },
        pitch: 0,
        yaw: 0,
        head_yaw: 0,
        delta: {
            x: position.x - this.currentPos.x,
            y: position.y - this.currentPos.y,
            z: position.z - this.currentPos.z,
        },
        input_data,
        interact_rotation: { x: 0, z: 0 },
        camera_orientation: { x: 0, y: 0, z: 0 },
        raw_move_vector: { x: 0, z: 0 },
        input_mode: getInputMode(this.options.userFlow.deviceOS),
        play_mode: "screen",
        interaction_model: "touch",
        tick: this.tick
    }

    if (num) {
        data.tick = this[`tick${num}`];

        data.delta = {
            x: position.x - this[`currentPos${num}`].x,
            y: position.y - this[`currentPos${num}`].y,
            z: position.z - this[`currentPos${num}`].z,
        }

        this[`currentPos${num}`] = {
            x: position.x,
            y: position.y,
            z: position.z
        }
    } else {
        this.currentPos = {
            x: position.x,
            y: position.y,
            z: position.z
        }
    }

    this.write(packetName, data);

    if (num) {
        this[`tick${num}`] += 1n;
    } else {
        this.tick += 1n;
    }
}

Client.prototype.sendCommand = function (command = "", source = 0, num = 0, configuration = { batchOptions: { enabled: false, count: 1 } }) {
    const {
        batchOptions = { enabled: false, count: 1 }
    } = configuration ?? {}

    let pktName = `command_request_${num}`;

    if (num === 0) pktName = 'command_request';

    const cmdPkt = {
        command: `/${command.substring(0, 511)}`,
        origin: {
            type: source == 5 ? "AutomationPlayer" : "Player",
            uuid: cmdOriginUUID,
            request_id: source == 5 ? cmdOriginUUID : "",
            player_entity_id: 0n
        },
        internal: source == 5 ? true : false,
        version: "Latest"
    }
    // tsl - I cooked hella on the no xuid exploit by using a Sub Packet on a Normal Client, should also work on text packet but dident tested
    !batchOptions.enabled ? this.write(pktName, cmdPkt) : this.writeBatch(pktName, cmdPkt, batchOptions.count);
}

Client.prototype.sendMessage = function (message = "", num = 0, configuration = { batchOptions: { enabled: false, count: 1 } }) {
    const {
        batchOptions = { enabled: false, count: 1 }
    } = configuration ?? {}

    let pktName = `text_${num}`;

    if (num === 0) pktName = 'text';

    const msgPkt = {
        type: "chat",
        needs_translation: false,
        category: "authored",
        chat: "chat",
        whisper: "whisper",
        announcement: "announcement",
        source_name: this.profile.displayName,
        message,
        xuid: this.profile.XUID,
        platform_chat_id: "",
        has_filtered_message: false
    }

    !batchOptions.enabled ? this.write(pktName, msgPkt) : this.writeBatch(pktName, msgPkt, batchOptions.count);
}

// tsl - sub clients now use none persona skins, see Info at https://discord.com/channels/@me/1411403884693426326/1459251967804182790 but we prefer to stay at the current for now
Client.prototype.createSubClient = function (num = 0, configuration) {
    if (typeof num !== "number") return;

    const {
        ssbp = { enabled: false, type: NaN },
        crash = { enabled: false, type: NaN },
        listeners = { enabled: false },
        batchOptions = { enabled: false, count: NaN },
        clg = { clgMsg: false, clgMsg: "", amount: 0, characterCount: 0 },
        name = { enabled: false, value: "" },
        massjoin = { enabled: false },
        clear = { enabled: false, uuid: NaN },
        deviceOS = { os: 11 }
    } = configuration ?? {}

    if (!listeners.enabled) this.disableSubListeners = true

    const jwtOptions = { algorithm: "ES384", notBefore: 0, expiresIn: 60, header: { x5u: this.clientX509, alg: "ES384" } }
    const PlayFabId = generateRandomString(16, "0123456789abcdef");
    let skinData

    if (massjoin.enabled && clg.clgMsg) return console.error('Invaild Sub Client option! Cant use massjoin & clg at the same time')
    if (massjoin.enabled && listeners.enabled) return console.error('Invaild Sub Client option! Cant use massjoin & listeners at the same time')

    if (massjoin.enabled) {
        skinData = {
            ThirdPartyName: name.enabled ? name.value : "",
            PersonaSkin: true,
            SelfSignedId: v3({ namespace: v4(), name: v4() }),
        }
    } else {
        skinData = {
            ClientRandomId: generateRandomString(19, "1234567890"),
            DeviceId: getDeviceId(deviceOS.os),
            DeviceOS: deviceOS.os,
            PlatformOfflineId: (deviceOS.os === 11 || deviceOS.os === 12) ? v3({ namespace: v4(), name: v4() }) : "",
            PlatformUserId: (deviceOS.os === 11 || deviceOS.os === 12) ? v3({ namespace: v4(), name: v4() }) : "",
            PlatformOnlineId: (clear.enabled && num == 1 || deviceOS.os === 11 || deviceOS.os === 12) ? generateRandomString(19, "1234567890") : "",
            PrimaryUser: false,
            SelfSignedId: clear.enabled ? clear.uuid : v3({ namespace: v4(), name: v4() }),
            DeviceModel: (deviceOS.os === 11 || deviceOS.os === 12) ? "playstation_5_emu" : "SAMSUNG SM-G955U",
            GUIScale: -1,
            LanguageCode: "en_US",
            OverrideSkin: false,
            CurrentInputMode: getInputMode(deviceOS.os),
            DefaultInputMode: getInputMode(deviceOS.os),
            UIProfile: 0,
            MaxViewDistance: 16,
            MemoryTier: 3,
            PlatformType: 2,
            GraphicsMode: ~~(Math.random() * 2),
            TrustedSkin: true,
            ThirdPartyName: name.enabled ? name.value : "", // Max Length 32 //tsl - method got patched again :( but migh make a return 
            ...skins[clg.enabled ? "clg" : "steve"]
        }
    }

    if (ssbp.enabled) {
        switch (ssbp.type) {
            case 2:
                skinData.PersonaPieces = [];
                break;
            case 3:
                skinData.PersonaPieces = Array(1000)
                break
            case 4:
                skinData.PersonaPieces = [
                    {
                        "IsDefault": false,
                        "PackId": "00000000-0000-0000-0000-000000000000",
                        "PieceId": "2bb1473b-9a5c-4eae-9fd5-82302a6aa3da",
                        "PieceType": "persona_unknown",
                        "ProductId": "2bb1473b-9a5c-4eae-9fd5-82302a6aa3da"
                    }
                ]
                break
            default:
                break;
        }
    }

    if (crash.enabled) {
        switch (crash.type) {
            case 1:
                this.chain = Array(50001).fill("")
                break;
            default:
                break;
        }
    }

    if (!massjoin.enabled) {
        if (skinData.PersonaSkin && !skinData?.PremiumSkin) {
            // Skin Data for Sub Clients suggest that our Skin ID starts with a UUIDv4 unlike main clients
            skinData.SkinId = `${v4()}.persona-${PlayFabId.toLowerCase()}-0`;
            skinData.SkinGeometry = btoa((atob(skinData.SkinGeometryData)).replaceAll(`aed7e8a4d485a49a-5`, `${PlayFabId.toLowerCase()}-0`));
            skinData.SkinResources = btoa((atob(skinData.SkinResourcePatch)).replaceAll(`aed7e8a4d485a49a-5`, `${PlayFabId.toLowerCase()}-0`));
        }

        if (clg.enabled && skinData.PremiumSkin && !skinData.PersonaSkin) {
            let jsonSkinGeoData = JSON.parse(atob(skinData.SkinGeometryData));

            jsonSkinGeoData = {
                format_version: '1.8.0',
                [`geometry.${clg.clgMsg.length != 0 ? clg.clgMsg.replaceAll(" ", ".") : generateRandomString(clg.characterCount)}`]: {
                    bones: Array(clg.amount).fill([]),
                    textureheight: 64,
                    texturewidth: 64
                }
            }

            skinData.SkinGeometry = btoa(JSON.stringify(jsonSkinGeoData, null, 2))
        }

        // Unused fields in Sub Clients
        delete skinData.SkinGeometryData, skinData.SkinResourcePatch;
    }

    let SCLPKT = {
        tokens: {
            identity: JSON.stringify({ AuthenticationType: 1, Certificate: JSON.stringify({ chain: this.chain }), Token: "" }),
            client: JWT.sign(skinData, this.privateKeyPEM, jwtOptions)
        }
    }, subClientId = num + 1;

    this[`skinData${subClientId}`] = skinData;

    batchOptions.enabled ? this.writeBatch(`sub_client_login_${subClientId}`, SCLPKT, batchOptions.count) : this.write(`sub_client_login_${subClientId}`, SCLPKT)

    if (listeners.enabled) {
        this.write(`request_chunk_radius_${subClientId}`, {
            chunk_radius: 16,
            max_radius: 16
        })

        this.write(`serverbound_loading_screen_${subClientId}`, {
            type: 1
        })

        this.on(`packet_violation_warning_${subClientId}`, (packet) => {
            console.log(packet)
        })

        this.on(`disconnect_${subClientId}`, (packet) => {
            if (packet.reason === "unexpected_packet") return;

            console.log(`Server tried disconnecting the #${subClientId} sub client.\nMessage: ${translateDisconnectMessage(packet)}`);
        })

        this.once(`start_game_${subClientId}`, (packet) => {
            // Looks so stupid to duplicate this, but it's necessary for the sub client to fully join.. even though it was called above already
            this.write(`request_chunk_radius_${subClientId}`, {
                chunk_radius: 16,
                max_radius: 16
            })

            this.write(`serverbound_loading_screen_${subClientId}`, {
                type: 1
            })

            this[`currentPos${subClientId}`] = packet.player_position;

            const movement = setInterval(() => {
                this.move({ x: this[`currentPos${subClientId}`].x, y: this[`currentPos${subClientId}`].y, z: this[`currentPos${subClientId}`].z }, subClientId);
            }, 20);

            this.localIntervals.push(movement);

            this.write(`serverbound_loading_screen_${subClientId}`, {
                type: 2
            })

            this.write(`set_local_player_as_initialized_${subClientId}`, { runtime_entity_id: packet.runtime_entity_id });

            this.on(`respawn_${subClientId}`, (data) => {
                switch (data.state) {
                    case 0:
                        this.write(`respawn_${subClientId}`, {
                            runtime_entity_id: packet.runtime_entity_id,
                            state: 2,
                            position: this[`currentPos${subClientId}`]
                        });

                        break;
                    case 1:
                        this.write(`player_action_${subClientId}`, {
                            runtime_entity_id: packet.runtime_entity_id,
                            action: 'respawn',
                            position: this[`currentPos${subClientId}`],
                            result_position: this[`currentPos${subClientId}`],
                            face: -1
                        });

                        break;
                }
            })
        });
    }
}

class bpClient {
    constructor(address, dbUser, server, configuration) {
        this.address = address;
        this.dbUser = dbUser;
        this.server = server;
        this.configuration = configuration ?? {};
        this.clients = [];
        this.api = new RealmAPI(dbUser.id); // remove when worlds are used but ill do that later
        this.intervals = [];
        this.userFlow = deviceMapping[dbUser.linkDevice] || {};
    }

    validate() {
        const transport = this.configuration.transport || "DEFAULT";
        const type = this.configuration.worldtype || "Realm";

        switch (transport) {
            case "DEFAULT":
                if (typeof this.address.ip !== "string") return "No IP";
                if (typeof this.address.port !== "number") return "No Port";
                if (!this.address.ip.includes(".")) return "Bad IP";
                if (this.address.port < 0 || this.address.port > 65535) return "Bad Port";
                break;
            case "NETHERNET":
            case "NETHERNET_JSONRPC":
                if(type === "Realm") {
                    if (typeof this.address.networkId !== "string") return "No Nethernet Network ID";
                    if (!this.address.networkId.includes("-")) return "Bad Nethernet Network ID";
                }
                break;
            default:
                return "Unsupported Network Protocol";
        }

        const { wsCrash = { enabled: false }, reconnect = { enabled: false } } = this.configuration;

        if (this.clients.length === 0) {
            if (wsCrash.enabled || reconnect.enabled) return null;

            if (ConcurrentUsers.has(this.dbUser.id)) return "Currently Doing Operation";
            if (ConcurrentRealms.includes(this.server.id)) return "Concurrent Operation";

            ConcurrentUsers.set(this.dbUser.id, 1);
            ConcurrentRealms.push(this.server.id);
        }

        return null;
    }

    #prepareOptions() {
        const {
            transport = "DEFAULT",
            crash = { enabled: false, type: NaN },
            worldtype = "Realm",
            clienttype = "Online",
            offlineprofile = { name: "Test", xuid: "", uuid: v4() },
            world = { world: null },
            useSignalling = true,
        } = this.configuration;

        const deviceOS = this.userFlow.deviceOS;

        return {
            host: this.address.ip,
            port: this.address.port,
            profilesFolder: getCacheFactory(this.dbUser),
            version: verData.version,
            authTitle: this.userFlow.authTitle,
            deviceType: this.userFlow.deviceType,
            flow: this.userFlow.flow,
            authflow: new Authflow(undefined, getCacheFactory(this.dbUser), {
                flow: this.userFlow.flow,
                authTitle: this.userFlow.authTitle,
                deviceType: this.userFlow.deviceType,
                deviceVersion: this.userFlow.deviceVersion,
                titleId: this.userFlow.titleId,
            }),
            transport,
            crash,
            offlineprofile,
            worldtype,
            ...world,
            clienttype,
            useSignalling,
            networkId: transport.startsWith("NETHERNET") ? this.address.networkId : "",
            userFlow: this.userFlow,
            userId: this.dbUser.id,
            skinData: this.#generateSkinData(deviceOS)
        }
    }

    #generateSkinData(deviceOS) {
        return {
            ClientRandomId: Number(generateRandomString(19, "1234567890")),
            CurrentInputMode: getInputMode(deviceOS),
            DefaultInputMode: getInputMode(deviceOS),
            DeviceModel: this.userFlow.deviceModel,
            DeviceOS: deviceOS,
            DeviceId: getDeviceId(deviceOS),
            GUIScale: [0, -1, -2][~~(Math.random() * 3)],
            LanguageCode: "en_US",
            OverrideSkin: false,
            PlatformOnlineId: deviceOS === 11 || deviceOS === 12 ? generateRandomString(19, "1234567890") : "",
            SelfSignedId: v3({ namespace: v4(), name: v4() }),
            UIProfile: this.userFlow.UIProfile,
            MaxViewDistance: this.userFlow.maxViewDistance,
            MemoryTier: this.userFlow.memoryTier,
            PlatformType: this.userFlow.platformType,
            GraphicsMode: ~~(Math.random() * 2),
            TrustedSkin: true,
            ...skins["steve"]
        }
    }

    async connect() {
        const validationError = this.validate();
        if (validationError) return validationError;

        const { count = 1 } = this.configuration;

        const spawnClient = async () => {
            const options = this.#prepareOptions();
            const client = createClient(options);

            client.wasKicked = false;
            client.options.protocolVersion = Number(verData.protocol);
            client.localIntervals = [];

            this.#applySkinCustomization(client);
            this.#registerListeners(client);

            this.clients.push(client);

            return client;
        }

        this.#setupPresence();

        if (count > 1) {
            const newClients = await Promise.all(Array(count).fill(0).map(() => spawnClient()));

            return newClients;
        } else {
            const client = await spawnClient();
            return client;
        }
    }

    #setupPresence() {
        if (this.intervals.length > 0) return;

        const updatePresence = () => {
            this.api.sendPresence({
                state: "active",
                activity: {
                    richPresence: {
                        id: `Realm_${this.server.gamemode}`,
                        scid: this.userFlow.scid
                    }
                }
            });

            if (this.configuration.worldtype === 'Realm') {
                this.api.sendInGamePresence(this.server, true);
            }
        }

        updatePresence();

        const interval = setInterval(updatePresence, 300000);

        this.intervals.push(interval);
    }

    #applySkinCustomization(client) {
        const { ssbp = { enabled: false } } = this.configuration;

        const skin = client.options.skinData;
        const playFabId = this.dbUser.playFabId.toLowerCase();

        skin.SkinId = `persona-${playFabId}-5`;
        const rPFID = (data) => btoa(atob(data).replaceAll(`aed7e8a4d485a49a-5`, `${playFabId}-5`));

        skin.SkinGeometryData = rPFID(skin.SkinGeometryData);
        skin.SkinResourcePatch = rPFID(skin.SkinResourcePatch);

        if (ssbp.enabled && ssbp.type === 1) skin.AnimatedImageData = Array(1000);
        if (typeof this.dbUser?.colors === "object") this.#applyColors(skin);
    }

    #applyColors(skin) {
        let updatedPieceTintColors = [...(skin?.PieceTintColors || [])];

        const { hair, eyes, tone, mouth } = this.dbUser.colors;

        if (tone && tone !== "default") skin.SkinColor = tone;

        const updateOrAddPiece = (currentPieces, pieceType, newColors, shouldUpdate) => {
            if (!shouldUpdate) return currentPieces;

            const index = currentPieces.findIndex((p) => p.PieceType === pieceType);

            if (index !== -1) return currentPieces.map((p, i) => i === index ? { ...p, Colors: newColors } : p);

            return [...currentPieces, { PieceType: pieceType, Colors: newColors }];
        }

        updatedPieceTintColors = updateOrAddPiece(
            updatedPieceTintColors,
            "persona_eyes",
            [eyes, "#ff2e180e", "#ffe9ecec", "#0"],
            eyes !== "default"
        );

        updatedPieceTintColors = updateOrAddPiece(
            updatedPieceTintColors,
            "persona_hair",
            [hair, "#ff2e180e", "#ffe9ecec", "#0"],
            hair !== "default"
        );

        updatedPieceTintColors = updateOrAddPiece(
            updatedPieceTintColors,
            "persona_mouth",
            [mouth, "#ff2e180e", "#ffe9ecec", "#0"],
            mouth !== "default"
        );

        skin.PieceTintColors = updatedPieceTintColors;
    }

    #registerListeners(client) {
        client._disconnect = client.disconnect;

        client.disconnect = () => this.disconnect(client);

        client.once("kick", (data) => {
            if (client.wasKicked) return;
            
            console.log(data)

            this.disconnect(client)
        });

        client.on("error", (error) => {
            if (client.wasKicked || error.partialReadError) return;

            client.emit("kick", { message: String(error) });
        });

        client.on("close", () => {
            if (client.wasKicked) return

            client.emit("kick", { message: "Connection closed unexpectedly" });
        });

        client.once("start_game", (packet) => {
            client.plrRuntimeID = packet.runtime_entity_id;
            client.currentPos = packet.player_position;

            const movement = setInterval(() => {
                client.move(client.currentPos, 0);
            }, 50);

            client.localIntervals.push(movement);

            client.write("serverbound_loading_screen", { type: 2 });
            client.write("set_local_player_as_initialized", { runtime_entity_id: packet.runtime_entity_id });

            client.on("respawn", (data) => {
                switch (data.state) {
                    case 0:
                        client.write("respawn", {
                            runtime_entity_id: packet.runtime_entity_id,
                            state: 2,
                            position: client.currentPos
                        });
                        break;
                    case 1:
                        client.write("player_action", {
                            runtime_entity_id: packet.runtime_entity_id,
                            action: "respawn",
                            position: client.currentPos,
                            result_position: client.currentPos,
                            face: -1
                        });
                        break;
                }
            });
        });

        client.on("move_player", (packet) => {
            if (packet.runtime_id === Number(client.plrRuntimeID)) client.currentPos = packet.position;
        });

        client.on("packet_violation_warning", (packet) => console.log(packet));
    }

    disconnect(client) {
        const targets = client ? [client] : [...this.clients];

        targets.forEach((client) => {
            if (client.localIntervals) client.localIntervals.forEach((int) => clearInterval(int));
            if (client.wasKicked) return;

            client.wasKicked = true;

            client._disconnect();

            const cIndex = this.clients.indexOf(client);
            if (cIndex > -1) this.clients.splice(cIndex, 1);
        });

        if (this.clients.length === 0) {
            if (this.configuration.worldtype === 'Realm') {
            const rIndex = ConcurrentRealms.indexOf(this.server.id);

            if (rIndex > -1) ConcurrentRealms.splice(rIndex, 1);

            ConcurrentUsers.delete(this.dbUser.id);

            this.intervals.forEach((int) => clearInterval(int));
            this.intervals = [];
            
            this.api.sendInGamePresence(this.server, false);
            }

            this.dbUser.attacks = (this.dbUser.attacks || 0) + 1;
            this.dbUser.save();
        }
    }
}

module.exports = bpClient