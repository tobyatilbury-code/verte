const XboxAPI = require("./Xbox.js");

const { deviceMapping, delay } = require("./Util.js");
const { userModel, whitelistedRealmsModel } = require("./Database.js");
const { checkRealm } = require("./Detection.js");

const verData = require("../ext/data.json");

class RealmAPI extends XboxAPI {
  constructor(accountID, crash = false) {
    super()
    this.accountID = accountID;
    this.crash = crash;

    this.maxRetries = 9;
    this.retryCount = 0;
    this.checksFailed = 0;
  }

  async init() {
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      if (this.alreadyInit) return;

      this.authToken = await this.getXboxAuthToken("https://pocket.realms.minecraft.net/");
      this.dbUser = await userModel.findOne({ id: this.accountID }, { linkDevice: 1, lastRealms: 1, blacklisted: 1 })
      this.whitelistedRealms = await whitelistedRealmsModel.find({}, { id: 1, _id: 0 }).lean();
      this.userFlow = deviceMapping[this.dbUser?.linkDevice ?? "Android"];

      this.headers = {
        "Accept": "*/*",
        "charset": "utf-8",
        "client-ref": "6e8fe469150fb2a32e233c69a51d7b44d1c01013",
        "client-version": this.crash ? "26.10.0" : verData.version,
        "x-clientplatform": this.userFlow?.deviceType ?? "Windows",
        "x-networkprotocolversion": this.crash ? "924" : verData.protocol,
        "authorization": this.authToken,
        "content-type": "application/json",
        "user-agent": this.userFlow?.userAgent ?? "MCPE/UWP",
        "Accept-Language": "en-US",
        "Accept-Encoding": "gzip, deflate, br",
        "Host": "bedrock.frontendlegacy.realms.minecraft-services.net",
        "Connection": "Keep-Alive"
      };

      this.alreadyInit = true;
    })();

    return this.initializing;
  }

  async runChecks(realm, config) {
    const {
      funct = "",
      realmCode = "",
      realmID = "",
      isBanned = false
    } = config ?? {}

    if (!this.dbUser) return;

    if (!this?.dbUser?.lastRealms) this.dbUser.lastRealms = [];

    let realmExists, lastRealm, checks = await checkRealm(this.accountID, realm, funct === "getRealmInfo" ? realmCode : "", funct === "getRealmInfo" ? false : true, isBanned);

    switch (funct) {
      case "getRealmInfo":
        if (typeof realmCode != "string") return { status: 1500, body: { errorMsg: "Error while checking realm code. Contact support.", errorCode: 1500 } }

        realmExists = this.dbUser.lastRealms.some((lastRealm) => lastRealm?.code === realmCode);

        lastRealm = {
          code: realmCode,
          time: Date.now(),
          isBanned,
          wasBanned: false
        }

        if (isBanned) {
          lastRealm.timeWhenBanned = Date.now();
          lastRealm.wasBanned = true;
        } else {
          lastRealm.id = realm.id
        }

        if (!realmExists) {
          this.dbUser.lastRealms.push(lastRealm);
        } else {
          const realmIndex = this.dbUser.lastRealms.findIndex((lastRealm) => lastRealm?.code === realmCode);

          if (realmIndex !== -1) {
            this.dbUser.lastRealms[realmIndex] = {
              ...this.dbUser.lastRealms[realmIndex],
              ...lastRealm
            }
          }
        }
        break;
      case "getRealmInfoByID":
        if (!realmID || !/^\d+$/.test(realmID)) return { status: 1500, body: { errorMsg: "Error while checking Realm ID. Contact support.", errorCode: 1500 } }

        realmExists = this.dbUser.lastRealms.some((lastRealm) => lastRealm?.id === realmID);

        lastRealm = {
          id: realmID,
          time: Date.now(),
          isBanned,
          wasBanned: false
        }

        if (isBanned) {
          lastRealm.timeWhenBanned = Date.now();
          lastRealm.wasBanned = true;
        }

        if (!realmExists) {
          this.dbUser.lastRealms.push(lastRealm);
        } else {
          const realmIndex = this.dbUser.lastRealms.findIndex((lastRealm) => lastRealm?.id === realmID);

          if (realmIndex !== -1) {
            this.dbUser.lastRealms[realmIndex] = {
              ...this.dbUser.lastRealms[realmIndex],
              ...lastRealm
            }
          }
        }
        break;
    }

    this.dbUser.markModified("lastRealms")
    await this.dbUser.save();

    for (const check of checks) {
      if (check.value) {
        switch (check.type) {
          case "low_members":
            return { status: 1403, body: { errorMsg: "The member count is too low for you to complete this.", errorCode: 1403 } }
          case "low_max_players":
            return { status: 1403, body: { errorMsg: "2 player realms aren't supported.", errorCode: 1403 } }
          case "default_realm_name":
            return { status: 1403, body: { errorMsg: "No realm name set on this realm yet. Check back soon.", errorCode: 1403 } }
          case "been_unbanned":
            await this.cleanLinkData("Blacklisted from End due to suspicious activity.", false, false, true);
            return { status: 1403, body: { errorMsg: "Something weird is going on here. You've been blacklisted for the time being. Contact Support for more information regarding this blacklist.", errorCode: 1403 } }
          case "realm_owned":
            return { status: 1403, body: { errorMsg: "You can't do a operation on a realm you own.", errorCode: 1403 } }
          default:
            return "NAR"
        }
      }
    }
  }

  async getRealms() {
    await this.init();

    this.retryCount = 0;

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch("https://bedrock.frontendlegacy.realms.minecraft-services.net/worlds", {
          method: "GET",
          headers: this.headers,
          signal: AbortSignal.timeout(15000)
        })

        switch (response.status) {
          case 200:
            let data = await response.text();

            try {
              data = JSON.parse(data);
            } catch {
              data = { status: response.status, body: data }
              return data
            }

            if (!data.servers) console.log(data.servers)

            return data.servers;
          case 403:
            break;
          case 502:
            await delay(2000);
            this.retryCount++;
            break;
          default:
            console.log(`Error: ${response.status} ${response.statusText}`);

            let body = await response.text();
            try {
              body = JSON.parse(body);
            } catch {
              body = { status: response.status, body }
              return body;
            }

            return { status: response.status, body }
        }
      } catch (error) {
        console.log(error);
        await delay(2000);
        this.retryCount++;
      }
    }
  }

  async getActivePlayers(realmID) {
    await this.init();

    this.retryCount = 0;

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/activities/live/players`, {
          method: "GET",
          headers: this.headers,
          signal: AbortSignal.timeout(15000)
        })

        switch (response.status) {
          case 200:
            let data = await response.text();
            try {
              data = JSON.parse(data);
            } catch {
              data = { status: response.status, body: data }
              return data
            }

            let server;

            data.servers.map((realm) => {
              if (realm.id === Number(realmID)) server = realm;
            })

            return server;
          case 403:
            break;
          case 502:
            await delay(2000);
            this.retryCount++;
            break;
          default:
            console.log(`Error: ${response.status} ${response.statusText}`);

            let body = await response.text();
            try {
              body = JSON.parse(body);
            } catch {
              body = { status: response.status, body }
              return body;
            }

            return { status: response.status, body }
        }
      } catch (error) {
        console.log(error);
        await delay(2000);
        this.retryCount++;
      }
    }
  }

  async getStorySettings(realmID) {
    await this.init();

    this.retryCount = 0;

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/worlds/${realmID}/stories/settings`, {
          method: "GET",
          headers: this.headers,
          signal: AbortSignal.timeout(15000)
        })

        switch (response.status) {
          case 200:
            let data = await response.text();
            try {
              data = JSON.parse(data);
            } catch {
              data = { status: response.status, body: data }
            }

            return data;
          default:
            let body = await response.text();
            try {
              body = JSON.parse(body);
            } catch {
              body = { status: response.status, body }
              return body;
            }

            return { status: response.status, body };
        }
      } catch (error) {
        console.log(error);
        await delay(2000);
        this.retryCount++;
      }
    }
  }

  async postStorySettings(realmID, notifications, autostories, coordinates, timeline) {
    await this.init();

    this.retryCount = 0;

    const body = JSON.stringify({
      notifications,
      autostories,
      coordinates,
      timeline,
      playerOptIn: "OPT_IN",
      realmOptIn: "OPT_IN"
    })

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/worlds/${realmID}/stories/settings`, {
          method: "POST",
          headers: {
            ...this.headers,
            "content-length": body.length,
          },
          body,
          signal: AbortSignal.timeout(15000)
        })

        return { status: response.status };
      } catch (error) {
        console.log(error);
        await delay(2000);
        this.retryCount++;
      }
    }
  }

  async getRealmInfo(realmCode, quick = false) {
    await this.init();

    this.retryCount = 0;

    let config = {
      realmCode,
      funct: "getRealmInfo",
      isBanned: false
    }

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/worlds/v1/link/${realmCode}`, {
          method: "GET",
          headers: this.headers,
          signal: AbortSignal.timeout(15000)
        })

        switch (response.status) {
          case 502:
            await delay(2000);
            this.retryCount++;
            break;
          case 200:
            let realm = await response.text();
            try {
              realm = JSON.parse(realm);
            } catch (error) {
              realm = { status: response.status, body: realm }
              return realm;
            }

            if (!realm.member) await this.joinRealm(realmCode);

            if (!quick) realm = await this.getRealmInfoByID(realm.id);

            let checkResult = await this.runChecks(realm, config);
            if (checkResult && checkResult != "NAR") return checkResult;

            if (!this.whitelistedRealms) return realm;

            for (const whitelistedRealm of this.whitelistedRealms) {
              if (realm.id === whitelistedRealm.id) {
                return { status: 1403, body: { errorMsg: "This realm is not available for use.", errorCode: 1403 } }
              }
            }

            await this.postStorySettings(realm.id, true, true, true, true);

            return realm
          case 403:
            let result = await response.text();
            try {
              result = JSON.parse(result);
            } catch {
              result = { status: response.status, body: result }
              return result;
            }

            if (result?.errorMsg === "User found in block list") {
              config.isBanned = true;

              let checkResult = await this.runChecks(null, config);
              if (checkResult && checkResult != "NAR") return checkResult;
            }

            return { status: response.status, body: result }
          case 429:
            return { status: 429, body: { errorMsg: "Too many requests sent to the Realms API.", errorCode: 429 } }
          default:
            console.log(`Error: ${response.status} ${response.statusText} getRealmInfo`);

            let body = await response.text();
            try {
              body = JSON.parse(body);
            } catch {
              body = { status: response.status, body }
              return body;
            }

            return { status: response.status, body }
        }
      } catch (error) {
        console.log(error);
        await delay(2000);
        this.retryCount++;
      }
    }
  }

  async getRealmInfoByID(realmID, isClientCalling = false) {
    await this.init();

    for (const realm of this.whitelistedRealms) {
      if (Number(realmID) === realm.id) {
        return { status: 1403, body: { errorMsg: "This realm is not available for use.", errorCode: 1403 } }
      }
    }

    this.retryCount = 0;

    let config = {
      realmID,
      funct: "getRealmInfoByID",
      isBanned: false
    }

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/worlds/${realmID}`, {
          method: "GET",
          headers: this.headers,
          signal: AbortSignal.timeout(15000)
        })

        switch (response.status) {
          case 200:
            let realm = await response.text();
            try {
              realm = JSON.parse(realm);
            } catch {
              realm = { status: response.status, body: realm }
              return realm;
            }

            let checkResult = await this.runChecks(realm, config);
            if (checkResult && checkResult != "NAR") return checkResult;

            await this.postStorySettings(realm.id, true, true, true, true);

            return realm;
          case 403:
            let result = await response.text();
            try {
              result = JSON.parse(result);
            } catch {
              result = { status: response.status, body: result }
              return result;
            }

            if (result?.errorMsg === "User found in block list") {
              config.isBanned = true;

              let checkResult = await this.runChecks(null, config);
              if (checkResult && checkResult != "NAR") return checkResult;
            }

            return { status: response.status, body: result }
          case 429:
            return { status: 429, body: { errorMsg: "Too many requests sent to the Realms API.", errorCode: 429 } }
          default:
            console.log(`Error: ${response.status} ${response.statusText} getRealmInfo`);

            let body = await response.text();
            try {
              body = JSON.parse(body);
            } catch {
              body = { status: response.status, body }
              return body;
            }

            return { status: response.status, body }
        }
      } catch (error) {
        if (isClientCalling) {
          return { status: 1500, body: { errorMsg: "An error occurred while fetching realm info by ID. The bpClient tried to call this request", errorCode: 1500 } }
        }

        console.log(error);
        await delay(2000);
        this.retryCount++;
      }
    }
  }

  async joinRealm(code) {
    await this.init();

    this.retryCount = 0;

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/invites/v1/link/accept/${code}`, {
          method: "POST",
          headers: this.headers,
          signal: AbortSignal.timeout(15000)
        })

        switch (response.status) {
          case 200:
            let data = await response.text();
            try {
              data = JSON.parse(data);
            } catch {
              data = { status: response.status, body: data }
            }

            await this.postStorySettings(data.id, true, true, true, true);

            return data
          default:
            console.log(`Error: ${response.status} ${response.statusText} joinRealm`);
            return { status: response.status, body: await response.text() }
        }
      } catch (error) {
        console.log(error);
        await delay(2000);
        this.retryCount++;
      }
    }
  }

  async leaveRealm(realmID) {
    await this.init();

    this.retryCount = 0;

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/invites/${realmID}`, {
          method: "DELETE",
          headers: this.headers,
          signal: AbortSignal.timeout(15000)
        })

        switch (response.status) {
          case 403:
            return "failed"
          case 204:
            return "success";
          default:
            console.log(`Error: ${response.status} ${response.statusText} ${await response.text()} leaveRealm`);
            return;
        }
      } catch (error) {
        console.log(error);
        await delay(2000);
        this.retryCount++;
      }
    }
  }

  async getRealmIP(realmID, callback) {
    await this.init();

    this.retryCount = 0;

    let delayTime = this.crash ? 10000 : 2000;

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: this.crash ? `All ${this.retryCount}/${this.maxRetries} request join attempts were successful.` : "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/worlds/${realmID}/join`, {
          method: "GET",
          headers: this.headers,
          signal: AbortSignal.timeout(15000)
        })

        let data;

        switch (response.status) {
          case 200:
            data = await response.text();
            try {
              data = JSON.parse(data);
            } catch {
              data = { status: response.status, body: data }
              return data;
            }

            return data;
          case 403:
          case 500:
            data = await response.text();
            try {
              data = JSON.parse(data);
              return { status: response.status, body: data };
            } catch {
              data = { status: response.status, body: data }
              return data;
            }
          case 503:
            await delay(delayTime);

            this.retryCount++;

            if (callback) callback(this.retryCount);
            break;
          default:
            console.log(`Error: ${response.status} ${response.statusText}`);

            let body = await response.text();
            try {
              body = JSON.parse(body);
            } catch {
              body = { status: response.status, body }
              return body;
            }

            return { status: response.status, body }
        }
      } catch (error) {
        console.log(error);

        await delay(delayTime);

        this.retryCount++;
        
        if (callback) callback(this.retryCount);
      }
    }
  }

  async getInvites() {
    await this.init();

    this.retryCount = 0;

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/invites/pending`, {
          method: "GET",
          headers: this.headers,
          signal: AbortSignal.timeout(15000)
        })

        switch (response.status) {
          case 200:
            let json = await response.text();
            try {
              json = JSON.parse(json);
            } catch {
              json = { status: response.status, body: json }
              return json;
            }

            return json.invites
          case 401:
            await this.cleanLinkData("Unauthorized, getInvites failed", false)
            return [];
          default:
            console.log(`Error: ${response.status} ${response.statusText}`);

            let body = await response.text();
            try {
              body = JSON.parse(body);
            } catch {
              body = { status: response.status, body }
              return body;
            }

            return { status: response.status, body }
        }
      } catch (error) {
        console.log(error);
        await delay(2000);
        this.retryCount++;
      }
    }
  }

  async acceptInvite(inviteId) {
    await this.init();

    this.retryCount = 0;

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/invites/accept/${inviteId}`, {
          method: "PUT",
          headers: this.headers,
          signal: AbortSignal.timeout(15000)
        })

        return { status: response.status }
      } catch (error) {
        console.log(error);
        await delay(2000);
        this.retryCount++;
      }
    }
  }

  async rejectInvite(inviteId) {
    await this.init();

    this.retryCount = 0;

    while (true) {
      try {
        if (this.retryCount > this.maxRetries) {
          return { status: 1429, body: { errorMsg: "You've hit the retry limit.", errorCode: 1429 } }
        }

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/invites/reject/${inviteId}`, {
          method: "PUT",
          headers: this.headers,
          signal: AbortSignal.timeout(15000)
        })

        return { status: response.status }
      } catch (error) {
        console.log(error);
        await delay(2000);
        this.retryCount++;
      }
    }
  }
}

module.exports = RealmAPI;