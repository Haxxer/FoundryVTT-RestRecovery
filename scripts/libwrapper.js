import ShortRestDialog from "./formapplications/short-rest/short-rest.js";
import CONSTANTS from "./constants.js";
import RestWorkflow from "./rest-workflow.js";
import LongRestDialog from "./formapplications/long-rest/long-rest.js";
import { getSetting } from "./lib/lib.js";

export default function registerLibwrappers() {
  
  // Actors
  patch_shortRest();
  patch_longRest();
  patch_rest();
  patch_displayRestResultMessage();
  patch_getRestHitPointRecovery();
  patch_getRestHitDiceRecovery();
  patch_getRestResourceRecovery();
  patch_getRestSpellRecovery();
  patch_getRestItemUsesRecovery();
  
  // Items
  patch_getUsageUpdates();
  
}


function patch_shortRest() {
  libWrapper.ignore_conflicts(CONSTANTS.MODULE_NAME, ["dnd5e-helpers"], [
    "CONFIG.Actor.documentClass.prototype.shortRest"
  ]);
  
  libWrapper.register(
    CONSTANTS.MODULE_NAME,
    "CONFIG.Actor.documentClass.prototype.shortRest",
    async function (config) {
      config = foundry.utils.mergeObject({
        dialog: true, chat: true, newDay: false, autoHD: false, autoHDThreshold: 3
      }, config);
  
      /**
       * A hook event that fires before a short rest is started.
       * @function dnd5e.preShortRest
       * @memberof hookEvents
       * @param {Actor5e} actor             The actor that is being rested.
       * @param {RestConfiguration} config  Configuration options for the rest.
       * @returns {boolean}                 Explicitly return `false` to prevent the rest from being started.
       */
      if ( Hooks.call("dnd5e.preShortRest", this, config) === false ) return;
      
      RestWorkflow.make(this);
  
      // Take note of the initial hit points and number of hit dice the Actor has
      const hd0 = this.system.attributes.hd;
      const hp0 = this.system.attributes.hp.value;
  
      // Display a Dialog for rolling hit dice
      if ( config.dialog ) {
        try { config.newDay = await ShortRestDialog.show({ actor: this });
        } catch(err) { return; }
      }
  
      // Automatically spend hit dice
      else if ( config.autoHD ) await this.autoSpendHitDice({ threshold: config.autoHDThreshold });
  
      // Return the rest result
      const dhd = this.system.attributes.hd - hd0;
      const dhp = this.system.attributes.hp.value - hp0;
      return this._rest(config.chat, config.newDay, false, dhd, dhp);
    },
    "OVERRIDE"
  );
}

function patch_longRest() {
  libWrapper.ignore_conflicts(CONSTANTS.MODULE_NAME, ["dnd5e-helpers"], [
    "CONFIG.Actor.documentClass.prototype.longRest"
  ]);
  
  libWrapper.register(
    CONSTANTS.MODULE_NAME,
    "CONFIG.Actor.documentClass.prototype.longRest",
    async function (config={}) {
      config = foundry.utils.mergeObject({
        dialog: true, chat: true, newDay: true
      }, config);
  
      /**
       * A hook event that fires before a long rest is started.
       * @function dnd5e.preLongRest
       * @memberof hookEvents
       * @param {Actor5e} actor             The actor that is being rested.
       * @param {RestConfiguration} config  Configuration options for the rest.
       * @returns {boolean}                 Explicitly return `false` to prevent the rest from being started.
       */
      if ( Hooks.call("dnd5e.preLongRest", this, config) === false ) return;
      
      RestWorkflow.make(this, true);
  
      if ( config.dialog ) {
        try { config.newDay = await LongRestDialog.show({ actor: this }); }
        catch(err) { return; }
      }
  
      return this._rest(config.chat, config.newDay, true);
    },
    "OVERRIDE"
  );
}

function patch_rest() {
  libWrapper.register(
    CONSTANTS.MODULE_NAME,
    "CONFIG.Actor.documentClass.prototype._rest",
    async function (chat, newDay, longRest, dhd = 0, dhp = 0) {
      let hitPointsRecovered = 0;
      let hitPointUpdates = {};
      let hitDiceRecovered = 0;
      let hitDiceUpdates = [];
      
      // Recover hit points & hit dice on long rest
      if (longRest) {
        ({ updates: hitPointUpdates, hitPointsRecovered } = this._getRestHitPointRecovery());
        ({ updates: hitDiceUpdates, hitDiceRecovered } = this._getRestHitDiceRecovery());
      }
      
      // Figure out the rest of the changes
      const result = {
        dhd: dhd + hitDiceRecovered,
        dhp: dhp + hitPointsRecovered,
        updateData: {
          ...hitPointUpdates,
          ...this._getRestResourceRecovery({
            recoverShortRestResources: !longRest,
            recoverLongRestResources: longRest
          }),
          ...this._getRestSpellRecovery({ recoverSpells: longRest })
        },
        updateItems: [
          ...hitDiceUpdates,
          ...this._getRestItemUsesRecovery({ recoverLongRestUses: longRest, recoverDailyUses: newDay })
        ],
        longRest,
        newDay
      };
  
      /**
       * A hook event that fires after rest result is calculated, but before any updates are performed.
       * @function dnd5e.preRestCompleted
       * @memberof hookEvents
       * @param {Actor5e} actor      The actor that is being rested.
       * @param {RestResult} result  Details on the rest to be completed.
       * @returns {boolean}          Explicitly return `false` to prevent the rest updates from being performed.
       */
      if ( Hooks.call("dnd5e.preRestCompleted", this, result) === false ) return result;
      
      if (longRest) {
        const workflow = RestWorkflow.get(this);
        result.updateData = await workflow._handleFoodWaterExhaustion(result.updateData);
        result.updateItems = await workflow._handleFoodAndWaterItems(result.updateItems);
      }
      
      // Perform updates
      await this.update(result.updateData);
      await this.updateEmbeddedDocuments("Item", result.updateItems);
      
      // Display a Chat Message summarizing the rest effects
      if (chat) await this._displayRestResultMessage(result, longRest);
  
      if ( Hooks.events.restCompleted?.length ) foundry.utils.logCompatibilityWarning(
        "The restCompleted hook has been deprecated in favor of dnd5e.restCompleted.",
        { since: "DnD5e 1.6", until: "DnD5e 2.1" }
      );
      /** @deprecated since 1.6, targeted for removal in 2.1 */
      Hooks.callAll("restCompleted", this, result);
  
      /**
       * A hook event that fires when the rest process is completed for an actor.
       * @function dnd5e.restCompleted
       * @memberof hookEvents
       * @param {Actor5e} actor      The actor that just completed resting.
       * @param {RestResult} result  Details on the rest completed.
       */
      Hooks.callAll("dnd5e.restCompleted", this, result);
      
      // Return data summarizing the rest effects
      return result;
    },
    "OVERRIDE"
  );
}

function patch_displayRestResultMessage() {
  libWrapper.register(
    CONSTANTS.MODULE_NAME,
    "CONFIG.Actor.documentClass.prototype._displayRestResultMessage",
    async function (wrapped, ...args) {
      const result = await wrapped(...args);
      const workflow = RestWorkflow.get(this);
      if (workflow) {
        await workflow._displayRestResultMessage(result)
      }
      return result;
    }
  )
  
}

function patch_getRestHitPointRecovery() {
  libWrapper.register(
    CONSTANTS.MODULE_NAME,
    "CONFIG.Actor.documentClass.prototype._getRestHitPointRecovery",
    function (wrapped, args) {
      return RestWorkflow.wrapperFn(this, wrapped, args, "_getRestHitPointRecovery")
    }
  )
}

function patch_getRestHitDiceRecovery() {
  libWrapper.register(
    CONSTANTS.MODULE_NAME,
    "CONFIG.Actor.documentClass.prototype._getRestHitDiceRecovery",
    function (wrapped, args) {
      if (getSetting(CONSTANTS.SETTINGS.PRE_REST_REGAIN_HIT_DICE)) {
        return RestWorkflow.wrapperFn(this, wrapped, args, "_getRestHitDiceRecoveryPost")
      }
      return RestWorkflow.wrapperFn(this, wrapped, args, "_getRestHitDiceRecoveryPre", false)
    }
  )
}

function patch_getRestResourceRecovery() {
  libWrapper.register(
    CONSTANTS.MODULE_NAME,
    "CONFIG.Actor.documentClass.prototype._getRestResourceRecovery",
    function (wrapped, args) {
      return RestWorkflow.wrapperFn(this, wrapped, args, "_getRestResourceRecovery")
    }
  )
}

function patch_getRestSpellRecovery() {
  libWrapper.register(
    CONSTANTS.MODULE_NAME,
    "CONFIG.Actor.documentClass.prototype._getRestSpellRecovery",
    function (wrapped, args) {
      return RestWorkflow.wrapperFn(this, wrapped, args, "_getRestSpellRecovery")
    }
  )
}

function patch_getRestItemUsesRecovery() {
  libWrapper.register(
    CONSTANTS.MODULE_NAME,
    "CONFIG.Actor.documentClass.prototype._getRestItemUsesRecovery",
    function (wrapped, args) {
      return RestWorkflow.wrapperFn(this, wrapped, args, "_getRestItemUsesRecovery")
    }
  )
}

function patch_getUsageUpdates() {
  libWrapper.register(
    CONSTANTS.MODULE_NAME,
    "CONFIG.Item.documentClass.prototype._getUsageUpdates",
    function ({ consumeQuantity, consumeRecharge, consumeResource, consumeSpellLevel, consumeUsage }) {
      
      // Reference item data
      const id = this.data;
      const actorUpdates = {};
      const itemUpdates = {};
      const resourceUpdates = isNewerVersion(game.system.data.version, "1.5.7") ? [] : {};
      
      // Consume Recharge
      if (consumeRecharge) {
        const recharge = id.recharge || {};
        if (recharge.charged === false) {
          ui.notifications.warn(game.i18n.format("DND5E.ItemNoUses", { name: this.name }));
          return false;
        }
        itemUpdates["data.recharge.charged"] = false;
      }
      
      // Consume Limited Resource
      if (consumeResource) {
        const canConsume = this._handleConsumeResource(itemUpdates, actorUpdates, resourceUpdates);
        if (canConsume === false) return false;
      }
      
      // Consume Spell Slots
      if (consumeSpellLevel) {
        if (Number.isNumeric(consumeSpellLevel)) consumeSpellLevel = `spell${consumeSpellLevel}`;
        const level = this.actor?.data.spells[consumeSpellLevel];
        const spells = Number(level?.value ?? 0);
        if (spells === 0) {
          const label = game.i18n.localize(consumeSpellLevel === "pact" ? "DND5E.SpellProgPact" : `DND5E.SpellLevel${id.level}`);
          ui.notifications.warn(game.i18n.format("DND5E.SpellCastNoSlots", { name: this.name, level: label }));
          return false;
        }
        actorUpdates[`data.spells.${consumeSpellLevel}.value`] = Math.max(spells - 1, 0);
      }
      
      const consumeFull = RestWorkflow.itemsListened.get(this.id) ?? true;
      
      // Consume Limited Usage
      if (consumeUsage) {
        const uses = id.uses || {};
        const available = Number(uses.value ?? 0);
        let used = false;
        
        // Reduce usages
        const remaining = Math.max(available - (consumeFull ? 1 : 0.5), 0);
        if (available > 0) {
          used = true;
          itemUpdates["data.uses.value"] = remaining;
        }
        
        // Reduce quantity if not reducing usages or if usages hit 0 and we are set to consumeQuantity
        if (consumeQuantity && (!used || (remaining === 0))) {
          const q = Number(id.quantity ?? 1);
          if (q >= 1) {
            used = true;
            itemUpdates["data.quantity"] = Math.max(q - 1, 0);
            itemUpdates["data.uses.value"] = uses.max ?? 1;
          }
        }
        
        // If the item was not used, return a warning
        if (!used) {
          ui.notifications.warn(game.i18n.format("DND5E.ItemNoUses", { name: this.name }));
          return false;
        }
      }
      
      // Return the configured usage
      return { itemUpdates, actorUpdates, resourceUpdates };
    },
    "OVERRIDE"
  )
}