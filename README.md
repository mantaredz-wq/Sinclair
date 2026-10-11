# Sinclair Anti-Nuke

A small Discord bot that watches the audit log for bursts of channel deletions,
role deletions, member bans, and member kicks. By default, one action triggers
quarantine (removing that user's roles); the detection window is five seconds.

## Setup

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications)
	and invite it with the `bot` and `applications.commands` scopes.
2. Grant it **View Audit Log** and **Manage Roles**. Put its highest role above
	the roles it may need to remove. For the optional ban response, also grant
	**Ban Members** and place the bot above the potential executor's roles.
3. Enable the **Server Members Intent** and **Message Content Intent** for the
	bot in the Developer Portal. They are needed for kick detection and prefix
	commands, respectively.
4. Copy `.env.example` to `.env`, then set `DISCORD_TOKEN` and `CLIENT_ID`.
	Set `DISCORD_GUILD_ID` to register commands immediately in one server;
	otherwise commands are registered globally and may take time to appear.
5. Run `npm install` and `npm start`.

## Docker container

1. Copy `.env.example` to `.env` and fill in your bot credentials.
2. Run `docker compose up --build` from the project root.
3. The bot uses a persistent `./data` volume so your server config and economy data remain across restarts.

Use `/antinuke status`, `/antinuke enable`, `/antinuke disable`,
`/antinuke threshold`, `/antinuke window`, `/antinuke punishment`, and
`/antinuke whitelist-add` and `/antinuke whitelist-remove` in Discord. These commands are restricted to
server administrators. Configuration is saved in `data/config.json`.
`/antinuke logs` shows the latest 10 recorded detections and their outcomes;
up to 25 entries per server are retained across bot restarts.

Use `/set prefix ?` to enable text commands with `?` (`off` disables them).
Available text commands are `?help`, `?avatar`/`?av`, `?cover`/`?cv`,
`?afk`, `?role <@user|user_id> <role name|mention|id>`,
`?currency balance|daily|gamble <amount>`, plus `?cbal`, `?cdaily`, and
`?cgamble <amount>` shortcuts. Avatar and cover commands can target a mentioned
user or the user in a replied-to message.
Message Content Intent must be enabled in the Developer Portal for these
commands to work.

Use `/role user role` to assign a role. The `user` value accepts a user mention
or ID; `role` accepts a role mention or ID, an exact name, or a unique starting
part of a name (for example, `rep` for `Representative`). Exact names take
priority; ambiguous partial names require more characters. The command requires
Manage Roles, and the bot must be above the target role and member in the role
hierarchy.

Use `/autoresponder add` with a trigger and response to create an automatic
reply, `/autoresponder remove` to delete a trigger, and `/autoresponder list` to
view configured triggers. Matching is case-insensitive; if multiple triggers
match a message, only the longest trigger responds. Administrators can configure
up to 50 triggers per server. Message Content Intent must be enabled.

The server currency game uses `/currency balance`, `/currency daily`,
`/currency gamble`, `/currency flip`, `/currency slots`, and `/currency mines`.
Prefix equivalents include `?currency balance|daily|gamble|slots`,
`?currency mines <amount> <bombs>`, `?currency flip <amount> <heads|tails>`,
the shortcuts `?cbal`, `?cdaily`, `?cgamble`, `?cflip <amount> <heads|tails>`,
`?cslot <amount>`, and `?cmines <amount> <bombs>`. Players start with 100
virtual coins and can claim a random 800-2,000 coins once every 24 hours. Coin
flip and gamble are even-money 50/50 games; Slots pays 3x-10x for three matching
symbols. Mines uses a 12-tile board where players choose 1-6 bombs; fewer bombs
mean lower cash-out multipliers. Safe picks raise the cash-out value, while
hitting a bomb loses the bet. Bets are capped at 1,000,000 coins. Balances are
separate per server and persist across bot restarts; coins have no real-world
value.

## Limits

Discord delivers these events after an action has happened. This bot can respond
to an identified executor, but cannot prevent the first action, restore deleted
channels or roles, undo bans, or protect against the server owner. Keep a trusted
owner account secure and maintain backups. Audit-log attribution can also be
delayed; if a matching audit entry is not available promptly, the action is
ignored rather than guessing who to punish.