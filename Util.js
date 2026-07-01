const cheerio = require('cheerio');
const { v3, v4fast: v4 } = require("uuid-1345");
const fs = require("node:fs");

const verData = require("../ext/data.json");

const { userModel } = require("./Database.js");
const { Titles } = require("../authentication/index.js");

function getCacheFactory(dbUser) {
  if (!dbUser.linkData) dbUser.linkData = {};

  class CacheFactory {
    async getCached() {
      return dbUser.linkData;
    }
    async setCached(value) {
      dbUser.linkData = value || {};

      try {
        await dbUser.save();
      } catch {
        dbUser = await userModel.findOne({ id: dbUser.id });

        dbUser.linkData = value || {};

        await dbUser.save();
      }
    }
    async setCachedPartial(value) {
      dbUser.linkData = {
        ...dbUser.linkData,
        ...value
      };

      try {
        await dbUser.save();
      } catch {
        dbUser = await userModel.findOne({ id: dbUser.id });

        dbUser.linkData = {
          ...dbUser.linkData,
          ...value
        };

        await dbUser.save();
      }
    }
  }
  return function () { return new CacheFactory(); };
}

function generateRandomString(length, characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890_-") {
  const array = new Uint8Array(length);

  for (let i = 0; i < length; i++) array[i] = characters.charCodeAt(~~(Math.random() * characters.length));

  return Buffer.from(array).toString();
}

async function getMCData() {
  verData.protocol = String(await getProtocolVersion());
  verData.version = String(await getGameVersion());
  verData.hash = String(await getHash());

  fs.writeFileSync(`./ext/data.json`, JSON.stringify(verData, null, 2));
}

async function getProtocolVersion() {
  try {
    const version = await getGameVersion();

    const response2 = await fetch(`https://minecraft.wiki/w/Bedrock_Edition_${version}`, {
      method: "GET"
    });

    const $ = cheerio.load((await response2.text()));
    const text = $('p').text();
    let protocolVersion = text.match(/\b\d{3}\b/g);

    if (protocolVersion) protocolVersion = protocolVersion.filter(version => Number(version) >= 900);
    if (!protocolVersion || protocolVersion.length === 0) protocolVersion = "944";

    return protocolVersion;
  } catch (error) {
    console.error(error);
    return "944";
  }
}

async function getGameVersion() {
  try {
    const response = await fetch(`https://itunes.apple.com/lookup?bundleId=com.mojang.minecraftpe&time=${Date.now()}`, {
      method: "GET",
    });

    const versionData = await response.json();
    const version = versionData.results[0].version;

    if (version.includes("26.")) return `1.${version}`;

    return version;
  } catch (error) {
    console.error(error);
    return "1.26.10";
  }
}

async function getHash() {
  try {
    const response = await fetch("https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main/versions.json", {
      method: "GET"
    });

    const versionData = await response.json()
    const version = versionData.windows.stable;

    const bds = await fetch(`https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main/windows/${version}.json`, {
      method: "GET"
    });

    const data = await bds.json();

    return data.commit_hash;
  } catch (error) {
    console.error(error);
    return "e672f33702ce73fed7df91a6530bc79c4f8ba656";
  }
}

function translateDisconnectMessage(disconnect) {
  try {
    let disconnectReasons = null;
    let message = "";

    if (!disconnect?.message.startsWith("%") && disconnect?.message.length === 0) {
      message = disconnect.reason;
      disconnectReasons = require("../ext/disconnects/disconnectReasons.json");
    } else {
      message = disconnect.message;
      disconnectReasons = require("../ext/disconnects/disconnectMessages.json");
    }

    for (const [key, value] of Object.entries(disconnectReasons)) {
      if (!message) return value;

      if (message.includes(key)) {
        message = message.replace(key, value).replace(/%/g, "").replace(/§./g, "");

        // Correctly handle %disconnect.kicked.reason, I could not find a better way to do it at the start.
        if (message.startsWith("You were kicked from the game.reason")) {
          message = message.replace("You were kicked from the game.reason", "You were kicked from the game:");
        }

        return message;
      }
    }
  } catch (error) {
    console.error(error);
  }

  if (typeof message === "undefined" || !message || typeof message != "string") return "Connection closed unexpectedly";
  if (typeof message === "string" && message.length > 0) return message;

  return message
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function cleanLeftovers(intervals, timeouts) {
  try {
    for (let i = 0; i < intervals.length; i++) clearInterval(intervals[i]);
    for (let i = 0; i < timeouts.length; i++) clearTimeout(timeouts[i]);
  } catch {} // Just in case of non existing intervals (cough cough sub client move intervals!)
}

function getVersionLog(version, returnAllVersions) {
  const content = fs.readFileSync("VERSION.md", 'utf8');
  const versions = {};

  const lines = content.split('\n');

  let currentVersionHeader = null;
  let currentVersionContent = [];

  for (const line of lines) {
    if (line.trim().startsWith('# v') && line.match(/^# v\d+\.\d+\.\d+$/)) {
      if (currentVersionHeader !== null) versions[currentVersionHeader.replaceAll("\n", "").replaceAll("# v", "")] = `${currentVersionHeader}\n${currentVersionContent.join('\n').trim()}`;

      currentVersionHeader = line.trim("#");
      currentVersionContent = [];
    } else if (currentVersionHeader !== null) currentVersionContent.push(line);
  }

  if (currentVersionHeader !== null) versions[currentVersionHeader.replaceAll("\n", "").replaceAll("# v", "")] = `${currentVersionHeader}\n${currentVersionContent.join('\n').trim()}`;

  for (const versionHeader in versions) {
    if (versionHeader === version && !returnAllVersions) return versions[versionHeader]
    if (returnAllVersions) return versions
  }
}

function componentToHex(c) {
  let hex = c.toString(16);
  return hex.length == 1 ? "0" + hex : hex;
}

function fillObjects(num, filled = false) {
  const populatedValue = {};

  for (let i = 0; i < num; i++) populatedValue[i] = filled ? { type: "byte", value: 0 } : {}

  return populatedValue
}

const deviceMapping = {
  "Android": {
    flow: "sisu",
    authTitle: Titles.MinecraftAndroid,
    deviceType: "Android",
    deviceOS: 1,
    maxViewDistance: 10,
    memoryTier: 3,
    platformType: 1,
    UIProfile: 1,
    scid: "00000000-0000-0000-0000-000067b57dac",
    deviceModel: "SAMSUNG SM-G955U",
    userAgent: "MCPE/Android",
    titleId: "1739947436",
    deviceVersion: "0.0.0"
  },
  "iOS": {
    flow: "sisu",
    authTitle: Titles.MinecraftIOS,
    deviceType: "iOS",
    deviceOS: 2,
    maxViewDistance: 18,
    memoryTier: 5,
    platformType: 1,
    UIProfile: 1,
    scid: "00000000-0000-0000-0000-00006bf082d7",
    deviceModel: "iPhone14,3",
    userAgent: "MCPE/iOS",
    titleId: "1810924247",
    deviceVersion: "0.0.0"
  }
};

function getDeviceId(deviceOS = 1) {
  if (!deviceOS) return;

  const deviceIdMap = {
    1: v4().replace(/-/g, ""),
    2: v4().replace(/-/g, "").toUpperCase(),
    11: v3({ namespace: v4(), name: v4() })
  };

  return deviceIdMap[deviceOS] || v4();
};

function getInputMode(deviceOS) {
  if (!deviceOS) return;

  const inputModeMap = {
    10: 3, 11: 3, 12: 3, 13: 3,
    1: 2, 2: 2, 4: 2, 14: 2,
    3: 1, 7: 1, 8: 1, 15: 1,
    5: 4, 6: 4,
    9: 0, 0: 0,
  };

  return inputModeMap[deviceOS] || null;
}

function translateUUID(uuid = "") {
  if (!uuid) return;

  // ts-check says this might be null at times, but like.. i dont care
  const bytes = uuid.replace(/-/g, "").match(/.{2}/g).reverse();

  if (!bytes) return;

  const hex = [...bytes.slice(8), ...bytes.slice(0, 8)].join("");

  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

module.exports = {
  getCacheFactory,
  getProtocolVersion,
  getGameVersion,
  getHash,
  getMCData,
  generateRandomString,
  translateDisconnectMessage,
  deviceMapping,
  delay,
  cleanLeftovers,
  getDeviceId,
  getInputMode,
  getVersionLog,
  componentToHex,
  translateUUID,
  fillObjects
}