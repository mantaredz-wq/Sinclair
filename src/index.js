require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomInt } = require('node:crypto');
const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  throw new Error('Set DISCORD_TOKEN and CLIENT_ID in your .env file.');
}

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');
const DEFAULT_CONFIG = {
  enabled: true,
  threshold: 1,
  windowSeconds: 5,
  punishment: 'quarantine',
  blockNewBots: false,
  autoRoleId: null,
  ownerRoleId: null,
  coOwnerRoleId: null,
  adminRoleId: null,
  psmRoleId: null,
  whitelist: [],
  whitelistRoles: [],
  antinukeLogs: [],
  autoresponders: [],
  economy: {
    balances: {},
    dailyClaims: {},
    luck: {},
    cluckCooldowns: {},
  },
  prefix: null,
  welcomeEmbed: null,
  tempVoice: {
    categoryId: null,
    createChannelId: null,
    roomName: "{user}'s room",
  },
  ticketPanel: {
    channelId: null,
    messageId: null,
  },
  ticketCategoryId: null,
  transcriptChannelId: null,
};
const recentActions = new Map();
const protectedExecutors = new Set();
const tempVoiceOwners = new Map();
const activeMinesGames = new Map();
const MINES_TILE_COUNT = 12;
const MINES_MAX_BOMBS = 6;

function readConfigs() {
  try {
    const configs = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return configs && typeof configs === 'object' ? configs : {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read config:', error);
    return {};
  }
}

let configs = readConfigs();

function getConfig(guildId) {
  const saved = configs[guildId] || {};
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    tempVoice: {
      ...DEFAULT_CONFIG.tempVoice,
      ...(saved.tempVoice || {}),
    },
    ticketPanel: {
      ...DEFAULT_CONFIG.ticketPanel,
      ...(saved.ticketPanel || {}),
    },
    ticketCategoryId: saved.ticketCategoryId || null,
    transcriptChannelId: saved.transcriptChannelId || null,
    whitelist: Array.isArray(saved.whitelist) ? saved.whitelist : [],
    whitelistRoles: Array.isArray(saved.whitelistRoles) ? saved.whitelistRoles : [],
    antinukeLogs: Array.isArray(saved.antinukeLogs) ? saved.antinukeLogs : [],
    autoresponders: Array.isArray(saved.autoresponders) ? saved.autoresponders : [],
    economy: {
      balances: saved.economy?.balances && typeof saved.economy.balances === 'object' ? saved.economy.balances : {},
      dailyClaims: saved.economy?.dailyClaims && typeof saved.economy.dailyClaims === 'object' ? saved.economy.dailyClaims : {},
      luck: saved.economy?.luck && typeof saved.economy.luck === 'object' ? saved.economy.luck : {},
      cluckCooldowns: saved.economy?.cluckCooldowns && typeof saved.economy.cluckCooldowns === 'object' ? saved.economy.cluckCooldowns : {},
    },
  };
}

function saveConfig(guildId, config) {
  configs[guildId] = config;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const temporaryPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(configs, null, 2));
  fs.renameSync(temporaryPath, CONFIG_PATH);
}

function recordAntinukeLog(guildId, entry) {
  const config = getConfig(guildId);
  config.antinukeLogs.unshift(entry);
  config.antinukeLogs = config.antinukeLogs.slice(0, 25);
  saveConfig(guildId, config);
}

function findRoleByName(guild, name) {
  const search = name.trim().toLowerCase();
  if (!search) return null;

  const roles = [...guild.roles.cache.values()];
  const exactMatch = roles.find((role) => role.name.toLowerCase() === search);
  if (exactMatch) return exactMatch;

  const partialMatches = roles.filter((role) => role.name.toLowerCase().startsWith(search));
  return partialMatches.length === 1 ? partialMatches[0] : null;
}

function hasProtectedRole(guild, member, config) {
  if (!guild || !member) return false;
  if (member.id === guild.ownerId) return true;

  const protectedRoleIds = [
    config.ownerRoleId,
    config.coOwnerRoleId,
    config.adminRoleId,
    config.psmRoleId,
  ].filter(Boolean);

  return protectedRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

function hasTicketStaffRole(guild, member, config) {
  if (!guild || !member) return false;
  if (member.id === guild.ownerId) return true;

  const staffRoleIds = [
    config.ownerRoleId,
    config.coOwnerRoleId,
    config.adminRoleId,
    config.psmRoleId,
  ].filter(Boolean);

  return staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

function extractDiscordInviteCodes(text) {
  const invitePattern = /(?:https?:\/\/)?(?:discord(?:app)?\.(?:gg|com\/invite)|discord\.gg|discordapp\.com\/invite)\/([A-Za-z0-9-]+)/gi;
  return [...text.matchAll(invitePattern)].map((match) => match[1].toLowerCase());
}

async function isInviteForGuild(guild, inviteCode) {
  if (!inviteCode) return false;
  try {
    const guildInvites = await guild.invites.fetch();
    return guildInvites.some((invite) => invite.code?.toLowerCase() === inviteCode.toLowerCase());
  } catch (error) {
    return false;
  }
}

async function handleExternalInviteLink(message) {
  const config = getConfig(message.guild.id);
  if (!config.enabled || message.author.bot || !message.guild) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  const roleWhitelisted = member ? config.whitelistRoles.some((roleId) => member.roles.cache.has(roleId)) : false;
  if (message.author.id === message.guild.ownerId || config.whitelist.includes(message.author.id) || roleWhitelisted || hasProtectedRole(message.guild, member, config)) return;

  const inviteCodes = extractDiscordInviteCodes(message.content);
  if (!inviteCodes.length) return;

  for (const inviteCode of inviteCodes) {
    if (await isInviteForGuild(message.guild, inviteCode)) continue;

    const now = Date.now();
    const key = `${message.guild.id}:${message.author.id}:invite`;
    const cutoff = now - config.windowSeconds * 1000;
    const timestamps = (recentActions.get(key) || []).filter((timestamp) => timestamp >= cutoff);
    timestamps.push(now);
    recentActions.set(key, timestamps);

    let outcome = 'Threshold not reached';
    if (timestamps.length >= config.threshold) {
      recentActions.delete(key);
      outcome = await punish(message.guild, message.author, config, timestamps.length);
    }

    recordAntinukeLog(message.guild.id, {
      timestamp: new Date(now).toISOString(),
      executorId: message.author.id,
      action: 'external invite link',
      actionCount: timestamps.length,
      threshold: config.threshold,
      outcome,
    });
    break;
  }
}

function getMinesMultiplier(safePicks, mineCount) {
  let survivalChance = 1;
  for (let pick = 0; pick < safePicks; pick += 1) {
    survivalChance *= (MINES_TILE_COUNT - mineCount - pick) / (MINES_TILE_COUNT - pick);
  }
  return 0.95 / survivalChance;
}

function spinSlots() {
  const symbols = ['🍒', '🍋', '🔔', '💎', '7️⃣'];
  const reels = Array.from({ length: 3 }, () => symbols[randomInt(0, symbols.length)]);
  const multipliers = { '🍒': 3, '🍋': 4, '🔔': 5, '💎': 8, '7️⃣': 10 };
  const multiplier = reels.every((symbol) => symbol === reels[0]) ? multipliers[reels[0]] : 0;
  return { reels, multiplier };
}

function scoreBlackjackHand(hand) {
  let total = 0;
  let aces = 0;

  for (const card of hand) {
    const rank = card.rank;
    if (rank === 'A') {
      total += 11;
      aces += 1;
    } else if (['K', 'Q', 'J'].includes(rank)) {
      total += 10;
    } else {
      total += Number(rank);
    }
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }

  return total;
}

function playBlackjackRound(amount) {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = suits.flatMap((suit) => ranks.map((rank) => ({ rank, suit, label: `${rank}${suit}` })));

  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }

  const player = [deck.pop(), deck.pop()];
  const dealer = [deck.pop(), deck.pop()];
  let playerScore = scoreBlackjackHand(player);
  let dealerScore = scoreBlackjackHand(dealer);

  while (dealerScore < 17 && deck.length > 0) {
    dealer.push(deck.pop());
    dealerScore = scoreBlackjackHand(dealer);
  }

  const playerBlackjack = player.length === 2 && playerScore === 21;
  const dealerBlackjack = dealer.length === 2 && dealerScore === 21;

  let delta = 0;
  let summary = 'Push';

  if (playerBlackjack && !dealerBlackjack) {
    delta = Math.ceil(amount * 1.5);
    summary = `Blackjack! You win **${delta.toLocaleString()} coins**.`;
  } else if (dealerBlackjack && !playerBlackjack) {
    delta = -amount;
    summary = `Dealer blackjack. You lose **${amount.toLocaleString()} coins**.`;
  } else if (playerScore > 21) {
    delta = -amount;
    summary = `You busted with ${playerScore}. You lose **${amount.toLocaleString()} coins**.`;
  } else if (dealerScore > 21) {
    delta = amount;
    summary = `Dealer busted with ${dealerScore}. You win **${amount.toLocaleString()} coins**.`;
  } else if (playerScore > dealerScore) {
    delta = amount;
    summary = `You win **${amount.toLocaleString()} coins**.`;
  } else if (playerScore < dealerScore) {
    delta = -amount;
    summary = `Dealer wins **${amount.toLocaleString()} coins**.`;
  } else {
    delta = 0;
    summary = 'Push. Your bet is returned.';
  }

  return {
    delta,
    summary,
    playerCards: player.map((card) => card.label).join(' '),
    dealerCards: dealer.map((card) => card.label).join(' '),
    playerScore,
    dealerScore,
  };
}

function resolveBlackjackDuel(challengerRound, targetRound) {
  const challengerBusted = challengerRound.playerScore > 21;
  const targetBusted = targetRound.playerScore > 21;

  if (challengerBusted && targetBusted) return 'push';
  if (challengerBusted) return 'target';
  if (targetBusted) return 'challenger';
  if (challengerRound.playerScore === targetRound.playerScore) return 'push';
  return challengerRound.playerScore > targetRound.playerScore ? 'challenger' : 'target';
}

function makeMinesComponents(session) {
  const rows = [];
  for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
    const row = new ActionRowBuilder();
    for (let columnIndex = 0; columnIndex < 4; columnIndex += 1) {
      const tileIndex = rowIndex * 4 + columnIndex;
      const isMine = session.mines.has(tileIndex);
      const isRevealed = session.revealed.has(tileIndex);
      const showMine = isMine && (session.ended || isRevealed);
      const button = new ButtonBuilder()
        .setCustomId(`mines:${session.id}:tile:${tileIndex}`)
        .setLabel(showMine ? '💣' : isRevealed ? '💎' : '?')
        .setStyle(showMine ? ButtonStyle.Danger : isRevealed ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(session.ended || isRevealed);
      row.addComponents(button);
    }
    rows.push(row);
  }

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mines:${session.id}:cashout`)
      .setLabel('Cash out')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(session.ended || session.revealed.size === 0),
  ));
  return rows;
}

function getMinesPrompt(session) {
  const picks = session.revealed.size;
  const multiplier = getMinesMultiplier(picks, session.mineCount);
  const payout = Math.floor(session.bet * multiplier);
  return `**Mines** | Bet: **${session.bet.toLocaleString()} coins** | Bombs: **${session.mineCount}** | Safe picks: **${picks}**\n` +
    `Cash-out multiplier: **${multiplier.toFixed(2)}x** | Cash-out value: **${payout.toLocaleString()} coins**\n` +
    'Choose a tile. Find a mine and the bet is lost; cash out after a safe pick to collect.';
}

function settleMinesGame(session, payout) {
  if (session.ended) return null;
  const config = getConfig(session.guildId);
  const storedBalance = config.economy.balances[session.userId];
  const balance = Number.isSafeInteger(storedBalance) && storedBalance >= 0 ? storedBalance : 0;
  config.economy.balances[session.userId] = Math.min(Number.MAX_SAFE_INTEGER, balance + payout);
  saveConfig(session.guildId, config);
  session.ended = true;
  activeMinesGames.delete(session.id);
  clearTimeout(session.timeout);
  return config.economy.balances[session.userId];
}

async function handleMinesButton(interaction) {
  const [, sessionId, action, rawTileIndex] = interaction.customId.split(':');
  const session = activeMinesGames.get(sessionId);
  if (!session) {
    await interaction.reply({ content: 'This Mines game has ended or expired.', ephemeral: true });
    return;
  }
  if (interaction.user.id !== session.userId) {
    await interaction.reply({ content: 'This is not your Mines game.', ephemeral: true });
    return;
  }
  if (session.busy) {
    await interaction.reply({ content: 'Your last move is still processing.', ephemeral: true });
    return;
  }

  session.busy = true;
  try {
    if (action === 'cashout') {
      if (!session.revealed.size) {
        await interaction.reply({ content: 'Reveal a safe tile before cashing out.', ephemeral: true });
        return;
      }
      const payout = Math.floor(session.bet * getMinesMultiplier(session.revealed.size, session.mineCount));
      const balance = settleMinesGame(session, payout);
      await interaction.update({
        content: `Cashed out **${payout.toLocaleString()} coins**. Your balance is now **${balance.toLocaleString()} coins**.\n${getMinesPrompt(session)}`,
        components: makeMinesComponents(session),
      });
      return;
    }

    const tileIndex = Number(rawTileIndex);
    if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= MINES_TILE_COUNT || session.revealed.has(tileIndex)) {
      await interaction.reply({ content: 'That tile is not available.', ephemeral: true });
      return;
    }

    if (session.mines.has(tileIndex)) {
      session.revealed.add(tileIndex);
      session.ended = true;
      activeMinesGames.delete(session.id);
      clearTimeout(session.timeout);
      const balance = getConfig(session.guildId).economy.balances[session.userId] || 0;
      await interaction.update({
        content: `You hit a mine and lost **${session.bet.toLocaleString()} coins**. Your balance is **${balance.toLocaleString()} coins**.\n${getMinesPrompt(session)}`,
        components: makeMinesComponents(session),
      });
      return;
    }

    session.revealed.add(tileIndex);
    if (session.revealed.size === MINES_TILE_COUNT - session.mineCount) {
      const payout = Math.floor(session.bet * getMinesMultiplier(session.revealed.size, session.mineCount));
      const balance = settleMinesGame(session, payout);
      await interaction.update({
        content: `All safe tiles found. You won **${payout.toLocaleString()} coins**. Your balance is **${balance.toLocaleString()} coins**.\n${getMinesPrompt(session)}`,
        components: makeMinesComponents(session),
      });
      return;
    }

    await interaction.update({ content: getMinesPrompt(session), components: makeMinesComponents(session) });
  } finally {
    session.busy = false;
  }
}

async function startMinesGame(guildId, userId, bet, mineCount, sendGameMessage) {
  if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount > MINES_MAX_BOMBS) {
    return { error: `Choose between 1 and ${MINES_MAX_BOMBS} bombs.` };
  }
  const config = getConfig(guildId);
  const storedBalance = config.economy.balances[userId];
  const balance = Number.isSafeInteger(storedBalance) && storedBalance >= 0 ? storedBalance : 100;
  if (bet > balance) return { error: `You only have **${balance.toLocaleString()} coins** to bet.` };

  config.economy.balances[userId] = balance - bet;
  saveConfig(guildId, config);

  const mines = new Set();
  while (mines.size < mineCount) mines.add(randomInt(0, MINES_TILE_COUNT));
  const session = {
    id: randomBytes(5).toString('hex'),
    guildId,
    userId,
    bet,
    mineCount,
    mines,
    revealed: new Set(),
    ended: false,
    busy: false,
    timeout: null,
    message: null,
  };
  activeMinesGames.set(session.id, session);

  try {
    session.message = await sendGameMessage({ content: getMinesPrompt(session), components: makeMinesComponents(session) });
    session.timeout = setTimeout(async () => {
      if (session.ended) return;
      if (session.busy) {
        session.timeout = setTimeout(() => void expireMinesGame(session), 1000);
        session.timeout.unref();
        return;
      }
      await expireMinesGame(session);
    }, 120_000);
    session.timeout.unref();
    return { session };
  } catch (error) {
    activeMinesGames.delete(session.id);
    const refundConfig = getConfig(guildId);
    const refundedBalance = refundConfig.economy.balances[userId] || 0;
    refundConfig.economy.balances[userId] = refundedBalance + bet;
    saveConfig(guildId, refundConfig);
    throw error;
  }
}

async function expireMinesGame(session) {
  if (session.ended) return;
  if (session.busy) {
    session.timeout = setTimeout(() => void expireMinesGame(session), 1000);
    session.timeout.unref();
    return;
  }
  const payout = session.revealed.size
    ? Math.floor(session.bet * getMinesMultiplier(session.revealed.size, session.mineCount))
    : session.bet;
  const balance = settleMinesGame(session, payout);
  if (balance === null) return;
  const message = session.revealed.size
    ? `Mines game timed out; auto-cashed out **${payout.toLocaleString()} coins**.`
    : `Mines game timed out before a move; refunded **${payout.toLocaleString()} coins**.`;
  await session.message.edit({
    content: `${message} Balance: **${balance.toLocaleString()} coins**.\n${getMinesPrompt(session)}`,
    components: makeMinesComponents(session),
  }).catch(() => null);
}

const commands = [
  new SlashCommandBuilder()
    .setName('antinuke')
    .setDescription('Configure anti-nuke protection')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((command) => command.setName('status').setDescription('Show protection settings'))
    .addSubcommand((command) => command.setName('logs').setDescription('Show recent anti-nuke detections and responses'))
    .addSubcommand((command) => command.setName('enable').setDescription('Enable protection'))
    .addSubcommand((command) => command.setName('disable').setDescription('Disable protection'))
    .addSubcommand((command) => command
      .setName('threshold')
      .setDescription('Set destructive actions allowed in the time window')
      .addIntegerOption((option) => option.setName('count').setDescription('Action count (1-10)').setMinValue(1).setMaxValue(10).setRequired(true)))
    .addSubcommand((command) => command
      .setName('window')
      .setDescription('Set the detection window in seconds')
      .addIntegerOption((option) => option.setName('seconds').setDescription('Time window (5-60 seconds)').setMinValue(5).setMaxValue(60).setRequired(true)))
    .addSubcommand((command) => command
      .setName('punishment')
      .setDescription('Choose the response to a detected burst')
      .addStringOption((option) => option
        .setName('action')
        .setDescription('Quarantine removes roles; ban removes the executor from the server')
        .setRequired(true)
        .addChoices(
          { name: 'Quarantine (remove roles)', value: 'quarantine' },
          { name: 'Ban', value: 'ban' },
        )))
    .addSubcommand((command) => command
      .setName('whitelist-add')
      .setDescription('Exempt a user from automatic punishment')
      .addUserOption((option) => option.setName('user').setDescription('User to exempt').setRequired(true)))
    .addSubcommand((command) => command
      .setName('whitelist-remove')
      .setDescription('Remove a user exemption')
      .addUserOption((option) => option.setName('user').setDescription('User to un-exempt').setRequired(true)))
    .addSubcommand((command) => command
      .setName('block-new-bots')
      .setDescription('Block or allow new bot joins')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Set to true to reject new bot joins').setRequired(true))),
  new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('Set the role given to every new member')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((option) => option.setName('role').setDescription('Role to assign to new members').setRequired(false)),
  new SlashCommandBuilder()
    .setName('role')
    .setDescription('Give a role to a server member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addStringOption((option) => option.setName('user').setDescription('User mention or ID').setRequired(true))
    .addStringOption((option) => option.setName('role').setDescription('Role name, mention, or ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Manage protected users and roles for anti-nuke checks')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((command) => command
      .setName('role')
      .setDescription('Add or remove a role from the whitelist')
      .addRoleOption((option) => option.setName('role').setDescription('Role to whitelist').setRequired(true)))
    .addSubcommand((command) => command
      .setName('list')
      .setDescription('List whitelisted users and roles')),
  new SlashCommandBuilder()
    .setName('autoresponder')
    .setDescription('Manage automatic keyword replies')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((command) => command
      .setName('add')
      .setDescription('Add or update a trigger and response')
      .addStringOption((option) => option.setName('trigger').setDescription('Text that activates the response').setMinLength(1).setMaxLength(80).setRequired(true))
      .addStringOption((option) => option.setName('response').setDescription('Message to send when the trigger appears').setMinLength(1).setMaxLength(1500).setRequired(true)))
    .addSubcommand((command) => command
      .setName('remove')
      .setDescription('Remove a trigger')
      .addStringOption((option) => option.setName('trigger').setDescription('Trigger to remove').setMinLength(1).setMaxLength(80).setRequired(true)))
    .addSubcommand((command) => command
      .setName('list')
      .setDescription('List configured triggers')),
  new SlashCommandBuilder()
    .setName('currency')
    .setDescription('Play the server virtual currency game')
    .addSubcommand((command) => command
      .setName('balance')
      .setDescription('Check your coin balance'))
    .addSubcommand((command) => command
      .setName('daily')
      .setDescription('Claim your daily coins'))
    .addSubcommand((command) => command
      .setName('gamble')
      .setDescription('Risk coins for a 50/50 chance to win')
      .addIntegerOption((option) => option.setName('amount').setDescription('Coins to bet').setMinValue(1).setMaxValue(1000000).setRequired(true)))
    .addSubcommand((command) => command
      .setName('flip')
      .setDescription('Predict heads or tails to win an even-money bet')
      .addIntegerOption((option) => option.setName('amount').setDescription('Coins to bet').setMinValue(1).setMaxValue(1000000).setRequired(true))
      .addStringOption((option) => option.setName('side').setDescription('Your prediction').setRequired(true).addChoices(
        { name: 'Heads', value: 'heads' },
        { name: 'Tails', value: 'tails' },
      )))
    .addSubcommand((command) => command
      .setName('slots')
      .setDescription('Spin three slots for a chance at a payout')
      .addIntegerOption((option) => option.setName('amount').setDescription('Coins to bet').setMinValue(1).setMaxValue(1000000).setRequired(true)))
    .addSubcommand((command) => command
      .setName('mines')
      .setDescription('Reveal safe tiles and cash out before hitting a mine')
      .addIntegerOption((option) => option.setName('amount').setDescription('Coins to bet').setMinValue(1).setMaxValue(1000000).setRequired(true))
      .addIntegerOption((option) => option.setName('bombs').setDescription('Bomb count (1-6); fewer bombs pay less').setMinValue(1).setMaxValue(6).setRequired(true)))
    .addSubcommand((command) => command
      .setName('blackjack')
      .setDescription('Play a one-hand blackjack round against the dealer')
      .addIntegerOption((option) => option.setName('amount').setDescription('Coins to bet').setMinValue(1).setMaxValue(1000000).setRequired(true)))
    .addSubcommand((command) => command
      .setName('cluck')
      .setDescription('Gain +1 luck; cooldown lasts 3 minutes') )
    .addSubcommand((command) => command
      .setName('pvp')
      .setDescription('Challenge a member to a blackjack duel')
      .addUserOption((option) => option.setName('user').setDescription('Opponent to challenge').setRequired(true))
      .addIntegerOption((option) => option.setName('amount').setDescription('Coins to bet (500-2000)').setMinValue(500).setMaxValue(2000).setRequired(true))),
  new SlashCommandBuilder()
    .setName('tsetup')
    .setDescription('Create a ticket panel with Tryout, Scrim, and Partnership buttons')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((option) => option.setName('channel').setDescription('Channel to post the ticket panel').addChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement]).setRequired(false)),
  new SlashCommandBuilder()
    .setName('ticketcategory')
    .setDescription('Set the category where new ticket channels will be created')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((option) => option.setName('category').setDescription('Ticket category').addChannelTypes([ChannelType.GuildCategory]).setRequired(false)),
  new SlashCommandBuilder()
    .setName('tickettranscript')
    .setDescription('Set the channel where ticket transcripts are posted')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((option) => option.setName('channel').setDescription('Text channel for transcripts').addChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement]).setRequired(false)),
  new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Set your nickname to [AFK] username and mark yourself as AFK')
    .addStringOption((option) => option.setName('reason').setDescription('Optional AFK reason').setRequired(false)),
  ...['avatar', 'av', 'cover', 'cv'].map((name) => new SlashCommandBuilder()
    .setName(name)
    .setDescription(name === 'cover' || name === 'cv' ? 'Show a user\'s profile cover' : 'Show a user\'s avatar')
    .addUserOption((option) => option.setName('user').setDescription('User to show (defaults to you)').setRequired(false))),
  new SlashCommandBuilder()
    .setName('edit-embed')
    .setDescription('Create or update the welcome embed template')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) => option.setName('title').setDescription('Title text').setRequired(false))
    .addStringOption((option) => option.setName('description').setDescription('Main body text').setRequired(false))
    .addStringOption((option) => option.setName('color').setDescription('Hex color like #5865F2').setRequired(false))
    .addStringOption((option) => option.setName('thumbnail').setDescription('Thumbnail URL').setRequired(false))
    .addStringOption((option) => option.setName('image').setDescription('Main image URL').setRequired(false))
    .addStringOption((option) => option.setName('footer').setDescription('Footer text').setRequired(false))
    .addChannelOption((option) => option.setName('channel').setDescription('Channel to send the welcome embed').setRequired(false))
    .addBooleanOption((option) => option.setName('preview').setDescription('Send a preview in the selected channel').setRequired(false)),
  new SlashCommandBuilder()
    .setName('message')
    .setDescription('Send a message in any text channel as the bot')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((option) => option.setName('channel').setDescription('Channel to send the message in').addChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement]).setRequired(true))
    .addStringOption((option) => option.setName('text').setDescription('Text to send').setMinLength(1).setMaxLength(2000).setRequired(true)),
  new SlashCommandBuilder()
    .setName('set')
    .setDescription('Server configuration commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((command) => command
      .setName('tempvoice')
      .setDescription('Configure temporary voice rooms')
      .addChannelOption((option) => option
        .setName('category')
        .setDescription('Category where temporary voice rooms will be created')
        .addChannelTypes([ChannelType.GuildCategory])
        .setRequired(true))
      .addChannelOption((option) => option
        .setName('joinchannel')
        .setDescription('Voice channel users join to create a temp room')
        .addChannelTypes([ChannelType.GuildVoice])
        .setRequired(true))
      .addStringOption((option) => option.setName('roomname').setDescription('Template for temp room names, example: {user}s room').setRequired(false)))
    .addSubcommand((command) => command
      .setName('prefix')
      .setDescription('Set the text-command prefix, or use off to disable it')
      .addStringOption((option) => option.setName('value').setDescription('Prefix (1-5 characters) or off').setMinLength(1).setMaxLength(5).setRequired(true)))
    .addSubcommand((command) => command
      .setName('owner')
      .setDescription('Set the owner-protected role')
      .addRoleOption((option) => option.setName('role').setDescription('Role to treat as owner-level protected').setRequired(false)))
    .addSubcommand((command) => command
      .setName('coowner')
      .setDescription('Set the co-owner-protected role')
      .addRoleOption((option) => option.setName('role').setDescription('Role to treat as co-owner protected').setRequired(false)))
    .addSubcommand((command) => command
      .setName('admin')
      .setDescription('Set the admin-protected role')
      .addRoleOption((option) => option.setName('role').setDescription('Role to treat as admin protected').setRequired(false)))
    .addSubcommand((command) => command
      .setName('psm')
      .setDescription('Set the PSM-protected role')
      .addRoleOption((option) => option.setName('role').setDescription('Role to treat as PSM protected').setRequired(false))),
].map((command) => command.toJSON());

function replaceEmbedVariables(guild, user, template) {
  const memberCount = guild.memberCount || 0;
  const serverName = guild.name || 'Server';
  const avatarUrl = user.displayAvatarURL?.({ extension: 'png', size: 512 }) || user.avatarURL?.() || '';
  const serverIcon = guild.iconURL?.({ extension: 'png', size: 512 }) || '';

  return String(template)
    .replace(/\{user\}/gi, `<@${user.id}>`)
    .replace(/\{user\.name\}/gi, user.username || 'User')
    .replace(/\{user\.tag\}/gi, user.tag || user.username || 'User')
    .replace(/\{user\.avatar\}/gi, avatarUrl)
    .replace(/\{server\.name\}/gi, serverName)
    .replace(/\{server\.icon\}/gi, serverIcon)
    .replace(/\{member\.count\}/gi, String(memberCount));
}

function buildWelcomeEmbed(guild, user, embedConfig) {
  const resolved = {
    title: replaceEmbedVariables(guild, user, embedConfig?.title || 'Welcome!'),
    description: replaceEmbedVariables(guild, user, embedConfig?.description || 'Welcome to {server.name}!'),
    color: Number.parseInt((embedConfig?.color || '#5865F2').replace('#', ''), 16) || 0x5865f2,
    thumbnail: embedConfig?.thumbnail ? { url: replaceEmbedVariables(guild, user, embedConfig.thumbnail) } : undefined,
    image: embedConfig?.image ? { url: replaceEmbedVariables(guild, user, embedConfig.image) } : undefined,
    footer: embedConfig?.footer ? { text: replaceEmbedVariables(guild, user, embedConfig.footer) } : undefined,
  };

  if (!resolved.thumbnail && embedConfig?.thumbnail === '{user.avatar}') {
    resolved.thumbnail = { url: replaceEmbedVariables(guild, user, '{user.avatar}') };
  }

  return {
    embeds: [resolved],
  };
}

function buildTicketPanelComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:tryout').setLabel('Tryout').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:scrim').setLabel('Scrim').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:partnership').setLabel('Partnership').setStyle(ButtonStyle.Secondary),
  );
}

async function sendTicketTranscript(guild, channel, closerUser) {
  const config = getConfig(guild.id);
  if (!config.transcriptChannelId) return;

  const transcriptChannel = guild.channels.cache.get(config.transcriptChannelId) || await guild.channels.fetch(config.transcriptChannelId).catch(() => null);
  if (!transcriptChannel || !transcriptChannel.isTextBased?.()) return;

  const ownerMatch = String(channel.topic || '').match(/ticket-owner:(\d+)/);
  const ticketOwnerId = ownerMatch ? ownerMatch[1] : null;
  const openTimestamp = Math.floor(channel.createdAt.getTime() / 1000);
  const closeTimestamp = Math.floor(Date.now() / 1000);

  const messageAsEmbed = new EmbedBuilder()
    .setTitle('Ticket Closed')
    .setColor(0x2f3136)
    .addFields(
      { name: 'Ticket ID', value: `\`${channel.id}\``, inline: true },
      { name: 'Opened By', value: ticketOwnerId ? `<@${ticketOwnerId}>` : 'Unknown', inline: true },
      { name: 'Closed By', value: closerUser ? `<@${closerUser.id}>` : 'Unknown', inline: true },
      { name: 'Open Time', value: `<t:${openTimestamp}:f>`, inline: true },
      { name: 'Closed Time', value: `<t:${closeTimestamp}:f>`, inline: true },
      { name: 'Claimed By', value: 'Unclaimed', inline: true },
      { name: 'Reason', value: 'No reason provided', inline: true },
    )
    .setFooter({ text: `Ticket: ${channel.name}` });

  await transcriptChannel.send({ embeds: [messageAsEmbed] });
}

async function createTicketChannel(guild, user, type) {
  const config = getConfig(guild.id);
  const staffRoleIds = [
    config.ownerRoleId,
    config.coOwnerRoleId,
    config.adminRoleId,
    config.psmRoleId,
  ].filter(Boolean);

  const channelName = `${type}-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 80);
  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: config.ticketCategoryId || guild.channels.cache.find((candidate) => candidate.type === ChannelType.GuildCategory && candidate.name.toLowerCase().includes('ticket'))?.id || undefined,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ...staffRoleIds.map((roleId) => ({
        id: roleId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      })),
    ],
    topic: `ticket-owner:${user.id}`,
  });

  const closeButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:close:${channel.id}`).setLabel('Close Ticket').setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: `Ticket opened by ${user}. Staff can reply here and close this ticket.`,
    components: [closeButton],
    allowedMentions: { parse: ['users'] },
  });

  return channel;
}

async function setupTicketPanel(guild, channel) {
  const message = await channel.send({
    components: [buildTicketPanelComponents()],
    allowedMentions: { parse: [] },
  });

  const config = getConfig(guild.id);
  config.ticketPanel = {
    channelId: channel.id,
    messageId: message.id,
  };
  saveConfig(guild.id, config);

  return message;
}

function makeTempVoiceControls(channel, owner) {
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tempvoice:lock:${channel.id}`).setLabel('Lock').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tempvoice:unlock:${channel.id}`).setLabel('Unlock').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tempvoice:hide:${channel.id}`).setLabel('Hide').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tempvoice:show:${channel.id}`).setLabel('Show').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tempvoice:claim:${channel.id}`).setLabel('Claim').setStyle(ButtonStyle.Primary),
  );

  const more = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tempvoice:rename:${channel.id}`).setLabel('Rename').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tempvoice:limit:${channel.id}`).setLabel('User limit').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tempvoice:info:${channel.id}`).setLabel('Info').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tempvoice:delete:${channel.id}`).setLabel('Delete').setStyle(ButtonStyle.Danger),
  );

  const embed = new EmbedBuilder()
    .setTitle('Temporary Voice Controls')
    .setDescription(`Manage ${owner}'s room using the controls below.`)
    .addFields(
      { name: 'Owner', value: owner.toString(), inline: true },
      { name: 'Access', value: 'Unlocked - Visible', inline: true },
      { name: 'User limit', value: 'Unlimited', inline: true },
    )
    .setColor(0x5865f2);

  return { embeds: [embed], components: [controls, more] };
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
});

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, DISCORD_GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Registered anti-nuke commands${DISCORD_GUILD_ID ? ` for ${DISCORD_GUILD_ID}` : ' globally'}.`);
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Anti-nuke protection bot ready as ${readyClient.user.tag}.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith('ticket:close:')) {
    if (!interaction.guild) {
      await interaction.reply({ content: 'Tickets can only be closed in a server.', ephemeral: true });
      return;
    }

    const channelId = interaction.customId.split(':')[2];
    const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      await interaction.reply({ content: 'That ticket channel no longer exists.', ephemeral: true });
      return;
    }

    const config = getConfig(interaction.guild.id);
    const member = interaction.member;
    const ownerMatch = String(channel.topic || '').match(/ticket-owner:(\d+)/);
    const ticketOwnerId = ownerMatch ? ownerMatch[1] : null;

    if (interaction.user.id === ticketOwnerId) {
      await interaction.reply({ content: 'You cannot close your own ticket.', ephemeral: true });
      return;
    }

    if (!hasTicketStaffRole(interaction.guild, member, config)) {
      await interaction.reply({ content: 'Only the configured owner/coowner/admin/PSM roles can close a ticket.', ephemeral: true });
      return;
    }

    await sendTicketTranscript(interaction.guild, channel, interaction.user);
    await channel.delete('Ticket closed by staff member').catch(async () => {
      await interaction.reply({ content: 'I could not close that ticket. Please check my permissions.', ephemeral: true });
    });

    await interaction.reply({ content: 'Ticket closed.', ephemeral: true });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket-modal:')) {
    const [, type] = interaction.customId.split(':');
    if (!interaction.guild) {
      await interaction.reply({ content: 'Ticket creation only works in a server.', ephemeral: true });
      return;
    }

    try {
      const createdChannel = await createTicketChannel(interaction.guild, interaction.user, type);
      const robloxUsername = interaction.fields.getTextInputValue('robloxUsername');
      const joinOrReferral = interaction.fields.getTextInputValue('joinOrReferral');
      const device = interaction.fields.getTextInputValue('device');

      await createdChannel.send({
        content: [
          `Tryout ticket opened by ${interaction.user}.`,
          '',
          `Roblox Username: ${robloxUsername}`,
          `Join or Referral: ${joinOrReferral}`,
          `Device: ${device}`,
        ].join('\n'),
        allowedMentions: { parse: ['users'] },
      });

      await interaction.reply({ content: `Your Tryout ticket has been created: ${createdChannel}.`, ephemeral: true });
    } catch (error) {
      console.error(`Could not create Tryout ticket for ${interaction.user.id}:`, error.message);
      await interaction.reply({ content: 'I could not create that ticket channel. Please check my permissions.', ephemeral: true });
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('ticket:')) {
    const [, type] = interaction.customId.split(':');
    if (!interaction.guild) {
      await interaction.reply({ content: 'Ticket creation only works in a server.', ephemeral: true });
      return;
    }

    if (type === 'tryout') {
      const modal = new ModalBuilder()
        .setCustomId(`ticket-modal:${type}`)
        .setTitle('Tryout Form');

      const robloxUsername = new TextInputBuilder()
        .setCustomId('robloxUsername')
        .setLabel('Roblox Username')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const joinOrReferral = new TextInputBuilder()
        .setCustomId('joinOrReferral')
        .setLabel('Join or Referral')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const device = new TextInputBuilder()
        .setCustomId('device')
        .setLabel('Device Cp or PC?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(robloxUsername),
        new ActionRowBuilder().addComponents(joinOrReferral),
        new ActionRowBuilder().addComponents(device),
      );

      await interaction.showModal(modal);
      return;
    }

    const label = type.charAt(0).toUpperCase() + type.slice(1);
    try {
      const createdChannel = await createTicketChannel(interaction.guild, interaction.user, type);
      await createdChannel.send({
        content: `Thanks for opening a ${label} ticket, ${interaction.user}! A staff member will assist you shortly.`,
        allowedMentions: { parse: ['users'] },
      });
      await interaction.reply({ content: `Your ${label} ticket has been created: ${createdChannel}.`, ephemeral: true });
    } catch (error) {
      console.error(`Could not create ticket channel for ${interaction.user.id}:`, error.message);
      await interaction.reply({ content: 'I could not create that ticket channel. Please check my permissions.', ephemeral: true });
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('mines:')) {
    try {
      await handleMinesButton(interaction);
    } catch (error) {
      console.error('Could not process Mines game interaction:', error.message);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'The Mines move could not be processed.', ephemeral: true }).catch(() => null);
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('tempvoice:')) {
    const [, action, channelId] = interaction.customId.split(':');
    const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      await interaction.reply({ content: 'This temporary voice room no longer exists.', ephemeral: true });
      return;
    }

    const ownerOverwrite = channel.permissionOverwrites.cache.find((overwrite) =>
      !interaction.guild.roles.cache.has(overwrite.id) && overwrite.allow.has(PermissionFlagsBits.ManageChannels));
    const ownerId = tempVoiceOwners.get(channel.id) || ownerOverwrite?.id || null;
    const isOwner = interaction.user.id === ownerId || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    const isInRoom = interaction.member.voice?.channelId === channel.id;

    if (action === 'lock' || action === 'unlock') {
      if (!isOwner) {
        await interaction.reply({ content: 'Only the room owner or a server administrator can lock or unlock this room.', ephemeral: true });
        return;
      }
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        Connect: action === 'lock' ? false : null,
      });
      await interaction.reply({ content: action === 'lock' ? 'Voice room locked.' : 'Voice room unlocked.', ephemeral: true });
      return;
    }

    if (!isInRoom) {
      await interaction.reply({ content: 'You must be in this room to use those controls.', ephemeral: true });
      return;
    }

    if (action === 'hide') {
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false });
      await interaction.reply({ content: 'Voice room hidden.', ephemeral: true });
      return;
    }
    if (action === 'show') {
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: true });
      await interaction.reply({ content: 'Voice room visible.', ephemeral: true });
      return;
    }
    if (action === 'claim') {
      if (!isOwner) {
        await interaction.reply({ content: 'Only the room owner can claim this room.', ephemeral: true });
        return;
      }
      tempVoiceOwners.set(channel.id, interaction.user.id);
      await interaction.reply({ content: 'You are now the owner of this room.', ephemeral: true });
      return;
    }
    if (action === 'rename') {
      const name = `${interaction.user.username}'s room`;
      await channel.setName(name);
      await interaction.reply({ content: `Room renamed to ${name}.`, ephemeral: true });
      return;
    }
    if (action === 'limit') {
      const limit = channel.userLimit === 0 ? 2 : 0;
      await channel.setUserLimit(limit);
      await interaction.reply({ content: `User limit set to ${limit === 0 ? 'unlimited' : limit}.`, ephemeral: true });
      return;
    }
    if (action === 'info') {
      await interaction.reply({ content: `Room: ${channel.name}\nOwner: <@${ownerId || interaction.user.id}>\nUsers: ${channel.members.size}`, ephemeral: true });
      return;
    }
    if (action === 'delete') {
      if (!isOwner) {
        await interaction.reply({ content: 'Only the room owner can delete it.', ephemeral: true });
        return;
      }
      await channel.delete('Temporary voice room deleted by owner');
      await interaction.reply({ content: 'Room deleted.', ephemeral: true });
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  if (['avatar', 'av', 'cover', 'cv'].includes(interaction.commandName)) {
    const target = interaction.options.getUser('user', false) || interaction.user;
    const isCover = interaction.commandName === 'cover' || interaction.commandName === 'cv';

    if (isCover) {
      const fullUser = await client.users.fetch(target.id, { force: true }).catch(() => target);
      const coverUrl = fullUser.bannerURL({ extension: 'png', size: 4096 });
      if (!coverUrl) {
        await interaction.reply({ content: `${target.username} does not have a profile cover.`, ephemeral: true });
        return;
      }
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle(`${target.username}'s profile cover`).setImage(coverUrl)] });
      return;
    }

    const avatarUrl = target.displayAvatarURL({ extension: 'png', size: 1024 });
    await interaction.reply({ embeds: [new EmbedBuilder().setTitle(`${target.username}'s avatar`).setImage(avatarUrl)] });
    return;
  }

  if (interaction.commandName === 'role') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.reply({ content: 'Manage Roles permission is required.', ephemeral: true });
      return;
    }

    const userInput = interaction.options.getString('user', true).trim();
    const roleInput = interaction.options.getString('role', true).trim();
    const userId = userInput.match(/^<@!?(\d+)>$/)?.[1] || ( /^\d{17,20}$/.test(userInput) ? userInput : null);
    const roleId = roleInput.match(/^<@&(\d+)>$/)?.[1] || (/^\d{17,20}$/.test(roleInput) ? roleInput : null);
    const member = userId ? await interaction.guild.members.fetch(userId).catch(() => null) : null;
    const role = roleId
      ? interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null)
      : findRoleByName(interaction.guild, roleInput);

    if (!member) {
      await interaction.reply({ content: 'I could not find that server member. Use a user mention or ID.', ephemeral: true });
      return;
    }
    if (!role || role.id === interaction.guild.id) {
      await interaction.reply({ content: 'I could not find one matching role. Use more of the name, a mention, or an ID.', ephemeral: true });
      return;
    }
    if (!role.editable || role.managed || !member.manageable) {
      await interaction.reply({ content: 'I cannot assign that role to this member. Check the bot and member role hierarchy.', ephemeral: true });
      return;
    }

    try {
      await member.roles.add(role, `Role command used by ${interaction.user.tag}`);
      await interaction.reply({ content: `Added ${role} to ${member}.`, ephemeral: true });
    } catch (error) {
      console.error(`Could not assign role ${role.id} to ${member.id}:`, error.message);
      await interaction.reply({ content: 'The role could not be assigned. Check the bot’s Manage Roles permission and role position.', ephemeral: true });
    }
    return;
  }

  if (interaction.commandName === 'autorole') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true });
      return;
    }

    const config = getConfig(interaction.guildId);
    const role = interaction.options.getRole('role', false);
    config.autoRoleId = role ? role.id : null;
    saveConfig(interaction.guildId, config);
    await interaction.reply({ content: role ? `Auto-role set to ${role.name}.` : 'Auto-role cleared.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'tsetup') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true });
      return;
    }

    const targetChannel = interaction.options.getChannel('channel', false) || interaction.channel;
    if (!targetChannel || !targetChannel.isTextBased?.()) {
      await interaction.reply({ content: 'Please pick a valid text channel for the ticket panel.', ephemeral: true });
      return;
    }

    await setupTicketPanel(interaction.guild, targetChannel);
    await interaction.reply({ content: `Ticket panel created in ${targetChannel}.`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'ticketcategory') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true });
      return;
    }

    const config = getConfig(interaction.guildId);
    const category = interaction.options.getChannel('category', false);
    config.ticketCategoryId = category ? category.id : null;
    saveConfig(interaction.guildId, config);
    await interaction.reply({ content: category ? `New tickets will be created in ${category}.` : 'Ticket category cleared.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'tickettranscript') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true });
      return;
    }

    const config = getConfig(interaction.guildId);
    const channel = interaction.options.getChannel('channel', false);
    config.transcriptChannelId = channel ? channel.id : null;
    saveConfig(interaction.guildId, config);
    await interaction.reply({ content: channel ? `Ticket transcripts will be sent to ${channel}.` : 'Transcript channel cleared.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'afk') {
    if (!interaction.guild || !interaction.member || !(interaction.member instanceof Object)) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const member = interaction.member;
    const reason = interaction.options.getString('reason', false) || 'AFK';
    const guild = interaction.guild;
    const newName = `[AFK] ${member.user.username}`;

    try {
      if (member.manageable && guild.members.me.permissions.has(PermissionFlagsBits.ManageNicknames)) {
        await member.setNickname(newName, `AFK via /afk - ${reason}`);
      }
      await interaction.reply({ content: `You are now AFK. Name changed to ${newName}.`, ephemeral: true });
      console.log(`AFK enabled for ${member.user.tag} in ${guild.name}: ${reason}`);
    } catch (error) {
      console.error(`Could not set AFK nickname for ${member.user.tag}:`, error.message);
      await interaction.reply({ content: 'I could not change your nickname. Check my permissions.', ephemeral: true });
    }
    return;
  }

  if (interaction.commandName === 'message') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true });
      return;
    }

    const targetChannel = interaction.options.getChannel('channel', true);
    const text = interaction.options.getString('text', true).trim();

    if (!targetChannel?.isTextBased?.()) {
      await interaction.reply({ content: 'That channel is not a text channel.', ephemeral: true });
      return;
    }

    try {
      await targetChannel.send({ content: text, allowedMentions: { parse: [] } });
      await interaction.reply({ content: `Message sent in ${targetChannel}.`, ephemeral: true });
    } catch (error) {
      console.error(`Could not send bot message to ${targetChannel.id}:`, error.message);
      await interaction.reply({ content: 'I could not send that message to the selected channel.', ephemeral: true });
    }
    return;
  }

  if (interaction.commandName === 'set') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const roleKeyMap = {
      owner: 'ownerRoleId',
      coowner: 'coOwnerRoleId',
      admin: 'adminRoleId',
      psm: 'psmRoleId',
    };
    const labelMap = {
      owner: 'Owner',
      coowner: 'Co-owner',
      admin: 'Admin',
      psm: 'PSM',
    };

    if (sub === 'tempvoice') {
      const config = getConfig(interaction.guildId);
      const category = interaction.options.getChannel('category', true);
      const joinChannel = interaction.options.getChannel('joinchannel', true);
      const roomName = interaction.options.getString('roomname', false) || '{user}\'s room';

      config.tempVoice = {
        categoryId: category.id,
        createChannelId: joinChannel.id,
        roomName,
      };
      saveConfig(interaction.guildId, config);

      await interaction.reply({
        content: `Temporary voice rooms enabled. Users who join ${joinChannel} will create a room in ${category}.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'prefix') {
      const value = interaction.options.getString('value', true).trim();
      if (/\s/.test(value)) {
        await interaction.reply({ content: 'The prefix cannot contain spaces.', ephemeral: true });
        return;
      }
      const config = getConfig(interaction.guildId);
      config.prefix = value.toLowerCase() === 'off' ? null : value;
      saveConfig(interaction.guildId, config);
      await interaction.reply({
        content: config.prefix ? `Text command prefix set to \`${config.prefix}\`.` : 'Text commands disabled.',
        ephemeral: true,
      });
      return;
    }

    if (sub in roleKeyMap) {
      const config = getConfig(interaction.guildId);
      const role = interaction.options.getRole('role', false);
      config[roleKeyMap[sub]] = role ? role.id : null;
      saveConfig(interaction.guildId, config);
      await interaction.reply({
        content: role ? `${labelMap[sub]} role set to ${role.name}.` : `${labelMap[sub]} role cleared.`,
        ephemeral: true,
      });
      return;
    }
  }

  if (interaction.commandName === 'edit-embed') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true });
      return;
    }

    const config = getConfig(interaction.guildId);
    const title = interaction.options.getString('title', false) || config.welcomeEmbed?.title || 'Welcome!';
    const description = interaction.options.getString('description', false) || config.welcomeEmbed?.description || 'Welcome to {server.name}!';
    const color = interaction.options.getString('color', false) || config.welcomeEmbed?.color || '#5865F2';
    const thumbnail = interaction.options.getString('thumbnail', false) || config.welcomeEmbed?.thumbnail || '{user.avatar}';
    const image = interaction.options.getString('image', false) || config.welcomeEmbed?.image || '{server.icon}';
    const footer = interaction.options.getString('footer', false) || config.welcomeEmbed?.footer || 'Enjoy your stay!';
    const targetChannel = interaction.options.getChannel('channel', false) || interaction.channel;
    const preview = interaction.options.getBoolean('preview', false) || false;

    config.welcomeEmbed = {
      title,
      description,
      color,
      thumbnail,
      image,
      footer,
      channelId: targetChannel ? targetChannel.id : null,
    };
    saveConfig(interaction.guildId, config);

    const resolvedEmbed = buildWelcomeEmbed(interaction.guild, interaction.user, config.welcomeEmbed);

    if (preview && targetChannel && targetChannel.isTextBased?.()) {
      await targetChannel.send({ embeds: [resolvedEmbed] });
    }

    await interaction.reply({
      content: 'Welcome embed template saved. Variables supported: {user.name}, {user.tag}, {user.avatar}, {server.name}, {server.icon}, {member.count}.',
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'whitelist') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true });
      return;
    }

    const config = getConfig(interaction.guildId);
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'role') {
      const role = interaction.options.getRole('role', true);
      const existed = config.whitelistRoles.includes(role.id);
      config.whitelistRoles = existed
        ? config.whitelistRoles.filter((value) => value !== role.id)
        : [...new Set([...config.whitelistRoles, role.id])];
      saveConfig(interaction.guildId, config);
      await interaction.reply({ content: existed ? `Removed ${role} from the whitelist.` : `Added ${role} to the whitelist.`, ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Whitelist')
      .setColor(0x5865f2)
      .addFields(
        {
          name: 'Users',
          value: config.whitelist.length ? config.whitelist.map((id) => `<@${id}>`).join(', ') : 'None',
          inline: false,
        },
        {
          name: 'Roles',
          value: config.whitelistRoles.length ? config.whitelistRoles.map((id) => `<@&${id}>`).join(', ') : 'None',
          inline: false,
        },
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (interaction.commandName === 'autoresponder') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true });
      return;
    }

    const config = getConfig(interaction.guildId);
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'add') {
      const trigger = interaction.options.getString('trigger', true).trim();
      const response = interaction.options.getString('response', true).trim();
      if (!trigger || !response) {
        await interaction.reply({ content: 'Trigger and response cannot be empty.', ephemeral: true });
        return;
      }
      const existing = config.autoresponders.find((entry) => entry.trigger.toLowerCase() === trigger.toLowerCase());
      if (existing) {
        existing.trigger = trigger;
        existing.response = response;
      } else {
        if (config.autoresponders.length >= 50) {
          await interaction.reply({ content: 'This server already has 50 triggers. Remove one before adding another.', ephemeral: true });
          return;
        }
        config.autoresponders.push({ trigger, response });
      }
      saveConfig(interaction.guildId, config);
      await interaction.reply({ content: `Autoresponder ${existing ? 'updated' : 'added'} for trigger: ${trigger}`, ephemeral: true });
      return;
    }

    if (subcommand === 'remove') {
      const trigger = interaction.options.getString('trigger', true).trim().toLowerCase();
      const initialLength = config.autoresponders.length;
      config.autoresponders = config.autoresponders.filter((entry) => entry.trigger.toLowerCase() !== trigger);
      if (config.autoresponders.length === initialLength) {
        await interaction.reply({ content: 'No autoresponder with that exact trigger was found.', ephemeral: true });
        return;
      }
      saveConfig(interaction.guildId, config);
      await interaction.reply({ content: `Removed autoresponder trigger: ${trigger}`, ephemeral: true });
      return;
    }

    const entries = config.autoresponders.slice(0, 40);
    const response = entries.length
      ? entries.map((entry) => `• ${entry.trigger} → ${entry.response.slice(0, 80)}`).join('\n').slice(0, 1900)
      : 'No autoresponders are configured.';
    await interaction.reply({ content: response, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'currency') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'The currency game can only be played in a server.', ephemeral: true });
      return;
    }

    const config = getConfig(interaction.guildId);
    const userId = interaction.user.id;
    const balances = config.economy.balances;
    const currentBalance = balances[userId];
    const balance = Number.isSafeInteger(currentBalance) && currentBalance >= 0 ? currentBalance : 100;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'balance') {
      balances[userId] = balance;
      saveConfig(interaction.guildId, config);
      await interaction.reply({ content: `You have **${balance.toLocaleString()} coins**.` });
      return;
    }

    if (subcommand === 'daily') {
      const now = Date.now();
      const lastClaim = Number(config.economy.dailyClaims[userId]) || 0;
      const cooldown = 24 * 60 * 60 * 1000;
      if (now - lastClaim < cooldown) {
        const hours = Math.ceil((cooldown - (now - lastClaim)) / (60 * 60 * 1000));
        await interaction.reply({ content: `Your next daily reward is available in about ${hours} hour${hours === 1 ? '' : 's'}.`, ephemeral: true });
        return;
      }

      const reward = randomInt(800, 2001);
      balances[userId] = balance + reward;
      config.economy.dailyClaims[userId] = now;
      saveConfig(interaction.guildId, config);
      await interaction.reply({ content: `Daily reward claimed: **${reward.toLocaleString()} coins**. You now have **${balances[userId].toLocaleString()} coins**.` });
      return;
    }

    if (subcommand === 'cluck') {
      const now = Date.now();
      const lastCluck = Number(config.economy.cluckCooldowns[userId]) || 0;
      const cooldown = 3 * 60 * 1000;
      if (now - lastCluck < cooldown) {
        const remainingMs = cooldown - (now - lastCluck);
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;
        await interaction.reply({ content: `Cluck is on cooldown. Try again in **${minutes}m ${seconds}s**.`, ephemeral: true });
        return;
      }

      const currentLuck = Number.isSafeInteger(config.economy.luck[userId]) ? config.economy.luck[userId] : 0;
      config.economy.luck[userId] = currentLuck + 1;
      config.economy.cluckCooldowns[userId] = now;
      saveConfig(interaction.guildId, config);
      await interaction.reply({ content: `🦆 Cluck! Your luck increased to **${config.economy.luck[userId]}**. You can use it again in 3 minutes.` });
      return;
    }

    const amount = interaction.options.getInteger('amount', true);

    if (subcommand === 'pvp') {
      const opponent = interaction.options.getUser('user', true);
      if (opponent.id === userId) {
        await interaction.reply({ content: 'You cannot challenge yourself to blackjack.', ephemeral: true });
        return;
      }
      if (amount < 500 || amount > 2000) {
        await interaction.reply({ content: 'PvP blackjack bets must be between **500** and **2000** coins.', ephemeral: true });
        return;
      }
      if (amount > balance) {
        await interaction.reply({ content: `You only have **${balance.toLocaleString()} coins** to bet.`, ephemeral: true });
        return;
      }
      const targetBalance = Number.isSafeInteger(config.economy.balances[opponent.id]) && config.economy.balances[opponent.id] >= 0 ? config.economy.balances[opponent.id] : 100;
      if (amount > targetBalance) {
        await interaction.reply({ content: `${opponent.tag} does not have enough coins for that challenge.`, ephemeral: true });
        return;
      }
      const playerRound = playBlackjackRound(amount);
      const opponentRound = playBlackjackRound(amount);
      const duelWinner = resolveBlackjackDuel(playerRound, opponentRound);

      if (duelWinner === 'challenger') {
        balances[userId] = Math.min(Number.MAX_SAFE_INTEGER, balance + amount);
        config.economy.balances[opponent.id] = Math.max(0, targetBalance - amount);
      } else if (duelWinner === 'target') {
        balances[userId] = Math.max(0, balance - amount);
        config.economy.balances[opponent.id] = Math.min(Number.MAX_SAFE_INTEGER, targetBalance + amount);
      } else {
        balances[userId] = balance;
        config.economy.balances[opponent.id] = targetBalance;
      }
      saveConfig(interaction.guildId, config);
      await interaction.reply({
        content: `🂡 ${interaction.user} challenged ${opponent} to blackjack for **${amount.toLocaleString()} coins**.\nYou: **${playerRound.playerCards}** (${playerRound.playerScore})\n${opponent}: **${opponentRound.playerCards}** (${opponentRound.playerScore})\nWinner: ${duelWinner === 'push' ? 'Push — both bets refunded.' : duelWinner === 'challenger' ? 'You win the pot.' : `${opponent} wins the pot.`}\nYour balance: **${balances[userId].toLocaleString()} coins**.`,
      });
      return;
    }

    if (subcommand === 'blackjack') {
      if (amount > balance) {
        await interaction.reply({ content: `You only have **${balance.toLocaleString()} coins** to bet.`, ephemeral: true });
        return;
      }
      if (balance + amount > Number.MAX_SAFE_INTEGER) {
        await interaction.reply({ content: 'Your balance is too high to safely place that bet.', ephemeral: true });
        return;
      }

      const round = playBlackjackRound(amount);
      const updatedBalance = Math.min(Number.MAX_SAFE_INTEGER, balance + round.delta);
      balances[userId] = updatedBalance;
      saveConfig(interaction.guildId, config);
      await interaction.reply({
        content: `🂡 Your hand: **${round.playerCards}** (${round.playerScore})\nDealer: **${round.dealerCards}** (${round.dealerScore})\n${round.summary}\nBalance: **${updatedBalance.toLocaleString()} coins**.`,
      });
      return;
    }
    if (amount > balance) {
      await interaction.reply({ content: `You only have **${balance.toLocaleString()} coins** to bet.`, ephemeral: true });
      return;
    }
    if (balance + amount * (subcommand === 'slots' ? 10 : 1) > Number.MAX_SAFE_INTEGER) {
      await interaction.reply({ content: 'Your balance is too high to safely place that bet.', ephemeral: true });
      return;
    }

    if (subcommand === 'flip') {
      const prediction = interaction.options.getString('side', true);
      const result = randomInt(0, 2) === 0 ? 'heads' : 'tails';
      const won = prediction === result;
      balances[userId] = won ? balance + amount : balance - amount;
      saveConfig(interaction.guildId, config);
      await interaction.reply({
        content: `🪙 It landed on **${result}**. ${won ? `You won **${amount.toLocaleString()} coins**.` : `You lost **${amount.toLocaleString()} coins**.`} Balance: **${balances[userId].toLocaleString()} coins**.`,
      });
      return;
    }

    if (subcommand === 'slots') {
      const { reels, multiplier } = spinSlots();
      const payout = amount * multiplier;
      balances[userId] = balance - amount + payout;
      saveConfig(interaction.guildId, config);
      await interaction.reply({
        content: `🎰 ${reels.join(' | ')}\n${multiplier ? `Three matching symbols! You won **${payout.toLocaleString()} coins** (${multiplier}x).` : `No match. You lost **${amount.toLocaleString()} coins**.`}\nBalance: **${balances[userId].toLocaleString()} coins**.`,
      });
      return;
    }

    if (subcommand === 'mines') {
      const mineCount = interaction.options.getInteger('bombs', true);
      try {
        const result = await startMinesGame(interaction.guildId, userId, amount, mineCount, async (payload) => {
          await interaction.reply({ ...payload, ephemeral: true });
          return interaction.fetchReply();
        });
        if (result.error) await interaction.reply({ content: result.error, ephemeral: true });
      } catch (error) {
        console.error('Could not start Mines game:', error.message);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Could not start the Mines game. Your bet was refunded.', ephemeral: true });
        }
      }
      return;
    }

    const won = randomInt(0, 2) === 1;
    balances[userId] = won ? balance + amount : balance - amount;
    saveConfig(interaction.guildId, config);
    await interaction.reply({
      content: `${won ? 'You won' : 'You lost'} **${amount.toLocaleString()} coins**. Your balance is now **${balances[userId].toLocaleString()} coins**.`,
    });
    return;
  }

  if (interaction.commandName !== 'antinuke') return;
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true });
    return;
  }

  const config = getConfig(interaction.guildId);
  const subcommand = interaction.options.getSubcommand();
  let response;

  if (subcommand === 'whitelist-add' || subcommand === 'whitelist-remove') {
    const user = interaction.options.getUser('user', true);
    if (subcommand === 'whitelist-add') {
      if (!config.whitelist.includes(user.id)) config.whitelist.push(user.id);
      response = `${user.tag} is now exempt from automatic punishment.`;
    } else {
      config.whitelist = config.whitelist.filter((id) => id !== user.id);
      response = `${user.tag} is no longer exempt.`;
    }
    saveConfig(interaction.guildId, config);
  } else if (subcommand === 'status') {
    response = `Protection: ${config.enabled ? 'enabled' : 'disabled'}\n` +
      `Threshold: ${config.threshold} actions in ${config.windowSeconds}s\n` +
      `Response: ${config.punishment}\n` +
      `Block new bots: ${config.blockNewBots ? 'enabled' : 'disabled'}\n` +
      `Auto-role: ${config.autoRoleId ? `<@&${config.autoRoleId}>` : 'none'}\n` +
      `Owner role: ${config.ownerRoleId ? `<@&${config.ownerRoleId}>` : 'none'}\n` +
      `Co-owner role: ${config.coOwnerRoleId ? `<@&${config.coOwnerRoleId}>` : 'none'}\n` +
      `Admin role: ${config.adminRoleId ? `<@&${config.adminRoleId}>` : 'none'}\n` +
      `PSM role: ${config.psmRoleId ? `<@&${config.psmRoleId}>` : 'none'}\n` +
      `Whitelisted users: ${config.whitelist.length}`;
  } else if (subcommand === 'logs') {
    const entries = config.antinukeLogs.slice(0, 10);
    response = entries.length
      ? entries.map((entry) => `<t:${Math.floor(Date.parse(entry.timestamp) / 1000)}:R> <@${entry.executorId}> — ${entry.action} (${entry.actionCount}/${entry.threshold}) — ${entry.outcome}`).join('\n')
      : 'No anti-nuke detections have been recorded yet.';
  } else if (subcommand === 'enable' || subcommand === 'disable') {
    config.enabled = subcommand === 'enable';
    saveConfig(interaction.guildId, config);
    response = `Anti-nuke protection ${config.enabled ? 'enabled' : 'disabled'}.`;
  } else if (subcommand === 'block-new-bots') {
    config.blockNewBots = interaction.options.getBoolean('enabled', true);
    saveConfig(interaction.guildId, config);
    response = `New bot joins are now ${config.blockNewBots ? 'blocked' : 'allowed'}.`;
  } else if (subcommand === 'threshold') {
    config.threshold = interaction.options.getInteger('count', true);
    saveConfig(interaction.guildId, config);
    response = `Threshold set to ${config.threshold} actions in ${config.windowSeconds}s.`;
  } else if (subcommand === 'window') {
    config.windowSeconds = interaction.options.getInteger('seconds', true);
    saveConfig(interaction.guildId, config);
    response = `Detection window set to ${config.windowSeconds} seconds.`;
  } else if (subcommand === 'punishment') {
    config.punishment = interaction.options.getString('action', true);
    saveConfig(interaction.guildId, config);
    response = `Automatic response set to ${config.punishment}.`;
  }

  await interaction.reply({ content: response || 'No change made.', ephemeral: true });
});

async function findExecutor(guild, auditType, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 6 });
    const entry = logs.entries.find((candidate) =>
      candidate.target?.id === targetId && Date.now() - candidate.createdTimestamp < 15_000);
    return entry?.executor || null;
  } catch (error) {
    console.error(`Could not read audit logs for ${guild.id}:`, error.message);
    return null;
  }
}

async function punish(guild, executor, config, actionCount) {
  const key = `${guild.id}:${executor.id}`;
  if (protectedExecutors.has(key)) return 'Punishment skipped (already handled recently)';
  protectedExecutors.add(key);
  setTimeout(() => protectedExecutors.delete(key), 60_000).unref();

  const reason = `Anti-nuke: ${actionCount} destructive actions within ${config.windowSeconds} seconds`;
  try {
    if (config.punishment === 'ban' && guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
      await guild.members.ban(executor.id, { reason });
      console.warn(`Banned ${executor.tag} from ${guild.name}. ${reason}`);
      return 'Banned';
    }

    if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      console.error(`Cannot quarantine ${executor.tag} in ${guild.name}: bot needs Manage Roles.`);
      return 'Failed: bot lacks Manage Roles';
    }
    const member = await guild.members.fetch(executor.id);
    if (!member.manageable) {
      console.error(`Cannot quarantine ${executor.tag} in ${guild.name}: role hierarchy blocks the bot.`);
      return 'Failed: role hierarchy blocks the bot';
    }
    await member.roles.set([], reason);
    console.warn(`Quarantined ${executor.tag} in ${guild.name}. ${reason}`);
    return 'Quarantined';
  } catch (error) {
    console.error(`Could not punish ${executor.tag} in ${guild.name}:`, error.message);
    return `Failed: ${error.message}`.slice(0, 80);
  }
}

async function handleDestructiveAction(guild, auditType, targetId, label) {
  const config = getConfig(guild.id);
  if (!config.enabled) return;

  const executor = await findExecutor(guild, auditType, targetId);
  if (!executor || executor.id === client.user.id) return;

  const member = await guild.members.fetch(executor.id).catch(() => null);
  const roleWhitelisted = member ? config.whitelistRoles.some((roleId) => member.roles.cache.has(roleId)) : false;
  if (executor.id === guild.ownerId || config.whitelist.includes(executor.id) || roleWhitelisted || hasProtectedRole(guild, member, config)) return;

  const now = Date.now();
  const key = `${guild.id}:${executor.id}`;
  const cutoff = now - config.windowSeconds * 1000;
  const timestamps = (recentActions.get(key) || []).filter((timestamp) => timestamp >= cutoff);
  timestamps.push(now);
  recentActions.set(key, timestamps);
  console.warn(`${executor.tag} performed ${label} in ${guild.name} (${timestamps.length}/${config.threshold}).`);

  let outcome = 'Threshold not reached';
  if (timestamps.length >= config.threshold) {
    recentActions.delete(key);
    outcome = await punish(guild, executor, config, timestamps.length);
  }

  recordAntinukeLog(guild.id, {
    timestamp: new Date(now).toISOString(),
    executorId: executor.id,
    action: label,
    actionCount: timestamps.length,
    threshold: config.threshold,
    outcome,
  });
}

client.on(Events.ChannelDelete, (channel) => {
  if (channel.guild) void handleDestructiveAction(channel.guild, AuditLogEvent.ChannelDelete, channel.id, 'channel deletion');
});

client.on(Events.GuildRoleDelete, (role) => {
  void handleDestructiveAction(role.guild, AuditLogEvent.RoleDelete, role.id, 'role deletion');
});

client.on(Events.GuildBanAdd, (ban) => {
  void handleDestructiveAction(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id, 'member ban');
});

client.on(Events.GuildMemberRemove, (member) => {
  void handleDestructiveAction(member.guild, AuditLogEvent.MemberKick, member.id, 'member kick');
});

client.on(Events.GuildMemberAdd, async (member) => {
  const config = getConfig(member.guild.id);

  if (config.autoRoleId) {
    const role = member.guild.roles.cache.get(config.autoRoleId) || await member.guild.roles.fetch(config.autoRoleId).catch(() => null);
    if (role && member.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles) && role.editable) {
      await member.roles.add(role, 'Anti-nuke: auto-role assignment').catch(() => null);
    }
  }

  if (config.welcomeEmbed) {
    const targetChannel = member.guild.channels.cache.get(config.welcomeEmbed.channelId) || await member.guild.channels.fetch(config.welcomeEmbed.channelId).catch(() => null);
    if (targetChannel && targetChannel.isTextBased?.()) {
      const embedPayload = buildWelcomeEmbed(member.guild, member.user, config.welcomeEmbed);
      await targetChannel.send(embedPayload).catch(() => null);
    }
  }

  if (member.user.bot === false) return;
  if (!config.enabled || !config.blockNewBots) return;
  if (member.id === member.guild.ownerId || member.user.id === client.user.id) return;

  try {
    if (member.guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) {
      await member.kick('Anti-nuke: blocked new bot join');
      console.warn(`Kicked new bot ${member.user.tag} from ${member.guild.name}: blocked by anti-nuke.`);
      return;
    }
    if (member.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
      await member.ban({ reason: 'Anti-nuke: blocked new bot join' });
      console.warn(`Banned new bot ${member.user.tag} from ${member.guild.name}: blocked by anti-nuke.`);
    }
  } catch (error) {
    console.error(`Could not block new bot ${member.user.tag} in ${member.guild.name}:`, error.message);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!newState.channel || oldState.channelId === newState.channelId) return;
  const guild = newState.guild;
  const config = getConfig(guild.id);
  const tempVoice = config.tempVoice || {};

  if (!tempVoice.categoryId || !tempVoice.createChannelId || newState.channelId !== tempVoice.createChannelId) return;
  if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) return;

  const ownerId = newState.member?.id;
  if (!ownerId) return;

  try {
    const roomName = String(tempVoice.roomName || "{user}'s room")
      .replace(/\{user\}/gi, newState.member.displayName || newState.member.user.username)
      .replace(/\{user\.name\}/gi, newState.member.user.username || 'User');

    const channel = await guild.channels.create({
      name: roomName,
      type: ChannelType.GuildVoice,
      parent: tempVoice.categoryId,
      permissionOverwrites: [
        { id: guild.roles.everyone, allow: [], deny: [PermissionFlagsBits.ViewChannel] },
        { id: ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.DeafenMembers, PermissionFlagsBits.Speak], deny: [] },
      ],
    });

    tempVoiceOwners.set(channel.id, ownerId);
    await newState.member.voice.setChannel(channel).catch(() => null);
    await channel.send(makeTempVoiceControls(channel, newState.member.user));
  } catch (error) {
    console.error(`Could not create temp voice for ${newState.member?.user.tag}:`, error.message);
  }
});


client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  await handleExternalInviteLink(message);

  const autoresponders = getConfig(message.guild.id).autoresponders;
  const messageText = message.content.toLowerCase();
  const matchingResponder = autoresponders
    .filter((entry) => typeof entry.trigger === 'string' && typeof entry.response === 'string' && entry.trigger && messageText.includes(entry.trigger.toLowerCase()))
    .sort((first, second) => second.trigger.length - first.trigger.length)[0];
  if (matchingResponder) {
    await message.reply({
      content: matchingResponder.response,
      allowedMentions: { parse: [], repliedUser: false },
    });
  }

  const prefix = getConfig(message.guild.id).prefix;
  if (prefix && message.content.startsWith(prefix)) {
    const [command, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
    const name = command?.toLowerCase();

    if (name === 'help') {
      await message.reply(`Commands: ${prefix}avatar [@user], ${prefix}cover [@user], ${prefix}afk [reason], ${prefix}role <@user|user_id> <role name|mention|id>, ${prefix}cluck, ${prefix}currency balance|daily|gamble|slots|blackjack|pvp|cluck <amount>, ${prefix}currency mines <amount> <bombs>, ${prefix}currency flip <amount> <heads|tails>, ${prefix}cbal, ${prefix}cdaily, ${prefix}cgamble <amount>, ${prefix}cslot <amount>, ${prefix}cmines <amount> <bombs>, ${prefix}cflip <amount> <heads|tails>, ${prefix}cbj <amount>, ${prefix}cpvp <@user> <amount>, ${prefix}ccluck`);
      return;
    }

    if (name === 'cluck' || name === 'ccluck') {
      const config = getConfig(message.guild.id);
      const userId = message.author.id;
      const now = Date.now();
      const lastCluck = Number(config.economy.cluckCooldowns[userId]) || 0;
      const cooldown = 3 * 60 * 1000;
      if (now - lastCluck < cooldown) {
        const remainingMs = cooldown - (now - lastCluck);
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;
        await message.reply(`Cluck is on cooldown. Try again in **${minutes}m ${seconds}s**.`);
        return;
      }

      const currentLuck = Number.isSafeInteger(config.economy.luck[userId]) ? config.economy.luck[userId] : 0;
      config.economy.luck[userId] = currentLuck + 1;
      config.economy.cluckCooldowns[userId] = now;
      saveConfig(message.guild.id, config);
      await message.reply(`🦆 Cluck! Your luck increased to **${config.economy.luck[userId]}**. You can use it again in 3 minutes.`);
      return;
    }

    const currencyShortcuts = { cbal: 'balance', cdaily: 'daily', cgamble: 'gamble', cslot: 'slots', cmines: 'mines', cflip: 'flip', cbj: 'blackjack', cpvp: 'pvp', ccluck: 'cluck' };
    const shortcutSubcommand = currencyShortcuts[name];
    if (name === 'currency' || shortcutSubcommand) {
      const config = getConfig(message.guild.id);
      const userId = message.author.id;
      const balances = config.economy.balances;
      const currentBalance = balances[userId];
      const balance = Number.isSafeInteger(currentBalance) && currentBalance >= 0 ? currentBalance : 100;
      const subcommand = shortcutSubcommand || args.shift()?.toLowerCase();

      if (subcommand === 'balance') {
        balances[userId] = balance;
        saveConfig(message.guild.id, config);
        await message.reply(`You have **${balance.toLocaleString()} coins**.`);
        return;
      }

      if (subcommand === 'daily') {
        const now = Date.now();
        const lastClaim = Number(config.economy.dailyClaims[userId]) || 0;
        const cooldown = 24 * 60 * 60 * 1000;
        if (now - lastClaim < cooldown) {
          const hours = Math.ceil((cooldown - (now - lastClaim)) / (60 * 60 * 1000));
          await message.reply(`Your next daily reward is available in about ${hours} hour${hours === 1 ? '' : 's'}.`);
          return;
        }

        const reward = randomInt(800, 2001);
        balances[userId] = balance + reward;
        config.economy.dailyClaims[userId] = now;
        saveConfig(message.guild.id, config);
        await message.reply(`Daily reward claimed: **${reward.toLocaleString()} coins**. You now have **${balances[userId].toLocaleString()} coins**.`);
        return;
      }

      if (subcommand === 'cluck') {
        const now = Date.now();
        const lastCluck = Number(config.economy.cluckCooldowns[userId]) || 0;
        const cooldown = 3 * 60 * 1000;
        if (now - lastCluck < cooldown) {
          const remainingMs = cooldown - (now - lastCluck);
          const remainingSeconds = Math.ceil(remainingMs / 1000);
          const minutes = Math.floor(remainingSeconds / 60);
          const seconds = remainingSeconds % 60;
          await message.reply(`Cluck is on cooldown. Try again in **${minutes}m ${seconds}s**.`);
          return;
        }

        const currentLuck = Number.isSafeInteger(config.economy.luck[userId]) ? config.economy.luck[userId] : 0;
        config.economy.luck[userId] = currentLuck + 1;
        config.economy.cluckCooldowns[userId] = now;
        saveConfig(message.guild.id, config);
        await message.reply(`🦆 Cluck! Your luck increased to **${config.economy.luck[userId]}**. You can use it again in 3 minutes.`);
        return;
      }

      if (subcommand === 'slots') {
        const amount = Number(args[0]);
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
          await message.reply(`Usage: ${prefix}${shortcutSubcommand ? `${name} <amount>` : 'currency slots <amount>'} (1-1,000,000)`);
          return;
        }
        if (amount > balance) {
          await message.reply(`You only have **${balance.toLocaleString()} coins** to bet.`);
          return;
        }
        if (balance - amount + amount * 10 > Number.MAX_SAFE_INTEGER) {
          await message.reply('Your balance is too high to safely place that bet.');
          return;
        }

        const { reels, multiplier } = spinSlots();
        const payout = amount * multiplier;
        balances[userId] = balance - amount + payout;
        saveConfig(message.guild.id, config);
        await message.reply(`🎰 ${reels.join(' | ')}\n${multiplier ? `Three matching symbols! You won **${payout.toLocaleString()} coins** (${multiplier}x).` : `No match. You lost **${amount.toLocaleString()} coins**.`}\nBalance: **${balances[userId].toLocaleString()} coins**.`);
        return;
      }

      if (subcommand === 'mines') {
        const amount = Number(args[0]);
        const mineCount = Number(args[1]);
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000 || !Number.isInteger(mineCount) || mineCount < 1 || mineCount > MINES_MAX_BOMBS) {
          await message.reply(`Usage: ${prefix}${shortcutSubcommand ? `${name} <amount> <bombs>` : 'currency mines <amount> <bombs>'} (1-1,000,000 coins, 1-${MINES_MAX_BOMBS} bombs)`);
          return;
        }
        try {
          const result = await startMinesGame(message.guild.id, userId, amount, mineCount, (payload) => message.reply(payload));
          if (result.error) await message.reply(result.error);
        } catch (error) {
          console.error('Could not start Mines game:', error.message);
          await message.reply('Could not start the Mines game. Your bet was refunded.');
        }
        return;
      }

      if (subcommand === 'blackjack') {
        const amount = Number(args[0]);
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
          await message.reply(`Usage: ${prefix}${shortcutSubcommand ? `${name} <amount>` : 'currency blackjack <amount>'} (1-1,000,000)`);
          return;
        }
        if (amount > balance) {
          await message.reply(`You only have **${balance.toLocaleString()} coins** to bet.`);
          return;
        }
        if (balance + amount > Number.MAX_SAFE_INTEGER) {
          await message.reply('Your balance is too high to safely place that bet.');
          return;
        }

        const round = playBlackjackRound(amount);
        balances[userId] = Math.min(Number.MAX_SAFE_INTEGER, balance + round.delta);
        saveConfig(message.guild.id, config);
        await message.reply(`🂡 Your hand: **${round.playerCards}** (${round.playerScore})\nDealer: **${round.dealerCards}** (${round.dealerScore})\n${round.summary}\nBalance: **${balances[userId].toLocaleString()} coins**.`);
        return;
      }

      if (subcommand === 'pvp') {
        const targetUser = message.mentions.users.first() || (args[0] ? await client.users.fetch(args[0]).catch(() => null) : null);
        const amount = Number(args[1]);
        if (!targetUser || targetUser.id === userId || !Number.isSafeInteger(amount) || amount < 500 || amount > 2000) {
          await message.reply(`Usage: ${prefix}${shortcutSubcommand ? `${name} <@user> <amount>` : 'currency pvp <@user> <amount>'} (500-2,000)`);
          return;
        }
        if (amount > balance) {
          await message.reply(`You only have **${balance.toLocaleString()} coins** to bet.`);
          return;
        }
        const targetBalance = Number.isSafeInteger(config.economy.balances[targetUser.id]) && config.economy.balances[targetUser.id] >= 0 ? config.economy.balances[targetUser.id] : 100;
        if (amount > targetBalance) {
          await message.reply(`${targetUser.tag} does not have enough coins for that challenge.`);
          return;
        }

        const playerRound = playBlackjackRound(amount);
        const targetRound = playBlackjackRound(amount);
        const duelWinner = resolveBlackjackDuel(playerRound, targetRound);

        if (duelWinner === 'challenger') {
          balances[userId] = Math.min(Number.MAX_SAFE_INTEGER, balance + amount);
          config.economy.balances[targetUser.id] = Math.max(0, targetBalance - amount);
        } else if (duelWinner === 'target') {
          balances[userId] = Math.max(0, balance - amount);
          config.economy.balances[targetUser.id] = Math.min(Number.MAX_SAFE_INTEGER, targetBalance + amount);
        } else {
          balances[userId] = balance;
          config.economy.balances[targetUser.id] = targetBalance;
        }
        saveConfig(message.guild.id, config);
        await message.reply(`🂡 ${message.author} challenged ${targetUser} to blackjack for **${amount.toLocaleString()} coins**.\nYou: **${playerRound.playerCards}** (${playerRound.playerScore})\n${targetUser}: **${targetRound.playerCards}** (${targetRound.playerScore})\nWinner: ${duelWinner === 'push' ? 'Push — both bets refunded.' : duelWinner === 'challenger' ? 'You win the pot.' : `${targetUser} wins the pot.`}\nYour balance: **${balances[userId].toLocaleString()} coins**.`);
        return;
      }

      if (subcommand === 'flip') {
        const amount = Number(args[0]);
        const prediction = args[1]?.toLowerCase();
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000 || !['heads', 'tails'].includes(prediction)) {
          await message.reply(`Usage: ${prefix}${shortcutSubcommand ? `${name} <amount> <heads|tails>` : 'currency flip <amount> <heads|tails>'}`);
          return;
        }
        if (amount > balance) {
          await message.reply(`You only have **${balance.toLocaleString()} coins** to bet.`);
          return;
        }
        if (balance + amount > Number.MAX_SAFE_INTEGER) {
          await message.reply('Your balance is too high to safely place that bet.');
          return;
        }

        const result = randomInt(0, 2) === 0 ? 'heads' : 'tails';
        const won = prediction === result;
        balances[userId] = won ? balance + amount : balance - amount;
        saveConfig(message.guild.id, config);
        await message.reply(`🪙 It landed on **${result}**. ${won ? `You won **${amount.toLocaleString()} coins**.` : `You lost **${amount.toLocaleString()} coins**.`} Balance: **${balances[userId].toLocaleString()} coins**.`);
        return;
      }

      if (subcommand === 'gamble') {
        const amount = Number(args[0]);
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
          await message.reply(`Usage: ${prefix}${shortcutSubcommand ? `${name} <amount>` : 'currency gamble <amount>'} (1-1,000,000)`);
          return;
        }
        if (amount > balance) {
          await message.reply(`You only have **${balance.toLocaleString()} coins** to bet.`);
          return;
        }
        if (balance + amount > Number.MAX_SAFE_INTEGER) {
          await message.reply('Your balance is too high to safely place that bet.');
          return;
        }

        const won = randomInt(0, 2) === 1;
        balances[userId] = won ? balance + amount : balance - amount;
        saveConfig(message.guild.id, config);
        await message.reply(`${won ? 'You won' : 'You lost'} **${amount.toLocaleString()} coins**. Your balance is now **${balances[userId].toLocaleString()} coins**.`);
        return;
      }

      await message.reply(`Usage: ${prefix}cluck, ${prefix}currency balance|daily|gamble|slots|blackjack|pvp|cluck <amount>, ${prefix}currency mines <amount> <bombs>, ${prefix}currency flip <amount> <heads|tails>, ${prefix}cslot <amount>, ${prefix}cmines <amount> <bombs>, ${prefix}cbj <amount>, ${prefix}cpvp <@user> <amount>, ${prefix}ccluck, or ${prefix}cflip <amount> <heads|tails>`);
      return;
    }

    if (['avatar', 'av', 'cover', 'cv'].includes(name)) {
      const repliedUser = message.reference
        ? await message.fetchReference().then((referencedMessage) => referencedMessage.author).catch(() => null)
        : null;
      const target = message.mentions.users.first() || repliedUser || message.author;
      const isCover = name === 'cover' || name === 'cv';

      if (isCover) {
        const fullUser = await client.users.fetch(target.id, { force: true }).catch(() => target);
        const coverUrl = fullUser.bannerURL({ extension: 'png', size: 4096 });
        if (!coverUrl) {
          await message.reply(`${target.username} does not have a profile cover.`);
          return;
        }
        await message.reply({ embeds: [new EmbedBuilder().setTitle(`${target.username}'s profile cover`).setImage(coverUrl)] });
        return;
      }

      const avatarUrl = target.displayAvatarURL({ extension: 'png', size: 1024 });
      await message.reply({ embeds: [new EmbedBuilder().setTitle(`${target.username}'s avatar`).setImage(avatarUrl)] });
      return;
    }

    if (name === 'role') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await message.reply('Manage Roles permission is required.');
        return;
      }
      if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await message.reply('I need the Manage Roles permission to assign roles.');
        return;
      }

      const userInput = args.shift() || '';
      const userId = message.mentions.users.first()?.id || userInput.match(/^<@!?(\d+)>$/)?.[1] || (/^\d{17,20}$/.test(userInput) ? userInput : null);
      const roleInput = args.join(' ').trim();
      const roleId = message.mentions.roles.first()?.id || roleInput.match(/^<@&(\d+)>$/)?.[1] || (/^\d{17,20}$/.test(roleInput) ? roleInput : null);
      const member = userId ? await message.guild.members.fetch(userId).catch(() => null) : null;
      const role = roleId
        ? message.guild.roles.cache.get(roleId) || await message.guild.roles.fetch(roleId).catch(() => null)
        : findRoleByName(message.guild, roleInput);

      if (!member) {
        await message.reply(`Usage: ${prefix}role <@user|user_id> <role name|mention|id>`);
        return;
      }
      if (!role || role.id === message.guild.id) {
        await message.reply('I could not find one matching role. Use more of the name, a mention, or an ID.');
        return;
      }
      if (!role.editable || role.managed || !member.manageable) {
        await message.reply('I cannot assign that role to this member. Check the bot and member role hierarchy.');
        return;
      }

      try {
        await member.roles.add(role, `Role command used by ${message.author.tag}`);
        await message.reply(`Added ${role} to ${member}.`);
      } catch (error) {
        console.error(`Could not assign role ${role.id} to ${member.id}:`, error.message);
        await message.reply('The role could not be assigned. Check the bot\'s Manage Roles permission and role position.');
      }
      return;
    }

    if (name === 'afk') {
      const member = message.member;
      if (!member) return;
      const reason = args.join(' ') || 'AFK';
      const newName = `[AFK] ${member.user.username}`;
      try {
        if (member.manageable && message.guild.members.me.permissions.has(PermissionFlagsBits.ManageNicknames)) {
          await member.setNickname(newName, `AFK via ${prefix}afk - ${reason}`);
          await message.reply(`You are now AFK. Name changed to ${newName}.`);
        } else {
          await message.reply('I could not change your nickname. Check my permissions and role position.');
        }
      } catch (error) {
        console.error(`Could not set AFK nickname for ${member.user.tag}:`, error.message);
        await message.reply('I could not change your nickname. Check my permissions.');
      }
      return;
    }
  }

  const member = message.member;
  if (!member || !member.nickname) return;

  if (!member.nickname.startsWith('[AFK] ')) return;

  try {
    if (message.guild.members.me.permissions.has(PermissionFlagsBits.ManageNicknames)) {
      const originalName = member.user.username;
      await member.setNickname(originalName, 'AFK ended after sending a message');
      console.log(`AFK cleared for ${member.user.tag} in ${message.guild.name}.`);
    }
  } catch (error) {
    console.error(`Could not clear AFK nickname for ${member.user.tag}:`, error.message);
  }
});

async function start() {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
}

start().catch((error) => {
  console.error('Could not start the anti-nuke bot:', error);
  process.exitCode = 1;
});