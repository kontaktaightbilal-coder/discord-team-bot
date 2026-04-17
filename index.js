import {
  Client,
  GatewayIntentBits,
  ChannelType,
  REST,
  Routes,
  ApplicationCommandOptionType,
  EmbedBuilder,
} from 'discord.js';

const token = process.env.TOKEN;
if (!token) {
  console.error('ERROR: TOKEN environment variable is not set.');
  process.exit(1);
}

// ── In-memory state ────────────────────────────────────────────────────
const stats = new Map(); // userId -> { id, name, wins, losses }
const matchHistory = []; // [{ team1, team2, score1, score2, date }]
let mapPool = ['Mirage', 'Inferno', 'Dust2', 'Nuke', 'Overpass', 'Anubis', 'Vertigo'];
let lastTeam1 = []; // [{ id, name }] — set when teams are created
let lastTeam2 = []; // [{ id, name }] — set when teams are created
let draft = null;   // active captain draft state

// ── Helpers ────────────────────────────────────────────────────────────
const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

const getVC = (guild, name) =>
  guild.channels.cache.find(
    (c) => c.name.toLowerCase() === name && c.type === ChannelType.GuildVoice,
  );

const ensureStat = (id, name) => {
  if (!stats.has(id)) stats.set(id, { id, name, wins: 0, losses: 0 });
  else stats.get(id).name = name;
};

const recordTeams = (t1, t2) => {
  lastTeam1 = t1.map((m) => ({ id: m.id, name: m.displayName }));
  lastTeam2 = t2.map((m) => ({ id: m.id, name: m.displayName }));
};

// ── Command definitions ────────────────────────────────────────────────
const commands = [
  { name: 'ping',       description: 'Check if the bot is alive and show latency' },
  { name: 'help',       description: 'Show all available commands' },
  { name: 'queue',      description: 'Show who is currently in the Queue voice channel' },
  { name: 'clearqueue', description: 'Remove all players from the Queue voice channel' },
  { name: 'coinflip',   description: 'Flip a coin' },
  { name: 'map',        description: 'Pick a random map from the pool' },
  { name: 'teams',      description: 'Split players from Queue into Team 1 and Team 2' },
  { name: 'reset',      description: 'Move all players from Team 1 and Team 2 back to Queue' },
  { name: 'shuffle',    description: 'Re-randomize the existing teams in place' },
  { name: 'draft',      description: 'Start a captain\'s draft from the Queue channel' },
  { name: 'leaderboard', description: 'Show player win/loss leaderboard' },
  {
    name: 'pick',
    description: 'Pick a player for your team (captains only, during a draft)',
    options: [
      { name: 'player', type: ApplicationCommandOptionType.User, description: 'Player to pick', required: true },
    ],
  },
  {
    name: 'swap',
    description: 'Swap two players between Team 1 and Team 2',
    options: [
      { name: 'player1', type: ApplicationCommandOptionType.User, description: 'First player', required: true },
      { name: 'player2', type: ApplicationCommandOptionType.User, description: 'Second player', required: true },
    ],
  },
  {
    name: 'sub',
    description: 'Sub a player from Queue in to replace a team player',
    options: [
      { name: 'player',  type: ApplicationCommandOptionType.User, description: 'Player coming in from Queue', required: true },
      { name: 'replace', type: ApplicationCommandOptionType.User, description: 'Player being replaced', required: true },
    ],
  },
  {
    name: 'score',
    description: 'Record the match result and update player stats',
    options: [
      { name: 'team1', type: ApplicationCommandOptionType.Integer, description: 'Team 1 score', required: true },
      { name: 'team2', type: ApplicationCommandOptionType.Integer, description: 'Team 2 score', required: true },
    ],
  },
  {
    name: 'history',
    description: 'Show recent match history',
    options: [
      { name: 'count', type: ApplicationCommandOptionType.Integer, description: 'Number of matches to show (default 5, max 10)', required: false },
    ],
  },
  {
    name: 'addmap',
    description: 'Add a map to the pool',
    options: [
      { name: 'name', type: ApplicationCommandOptionType.String, description: 'Map name', required: true },
    ],
  },
  {
    name: 'removemap',
    description: 'Remove a map from the pool',
    options: [
      { name: 'name', type: ApplicationCommandOptionType.String, description: 'Map name', required: true },
    ],
  },
];

// ── Client setup ───────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('clientReady', async (c) => {
  console.log(`Bot online: ${c.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
  console.log(`${commands.length} commands registered.`);
});

// ── Interaction handler ────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  if (!guild) return interaction.reply('This command must be used in a server.');

  const cmd = interaction.commandName;

  // ── /ping ────────────────────────────────────────────────────────────
  if (cmd === 'ping') {
    return interaction.reply(`🏓 Pong! Latenz: **${client.ws.ping}ms**`);
  }

  // ── /help ────────────────────────────────────────────────────────────
  if (cmd === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('📖 Alle Commands')
      .setColor(0x5865f2)
      .addFields(
        {
          name: '🎮 Team Management',
          value:
            '`/teams` — Queue in Team 1 & 2 aufteilen\n' +
            '`/reset` — Teams zurück in Queue\n' +
            '`/shuffle` — Teams neu mischen\n' +
            '`/swap @p1 @p2` — Zwei Spieler tauschen\n' +
            '`/sub @rein @raus` — Queue-Spieler einwechseln',
        },
        {
          name: '🧢 Captain Draft',
          value:
            '`/draft` — Captain-Draft starten\n' +
            '`/pick @spieler` — Spieler picken (nur Captains)',
        },
        {
          name: '📊 Stats & Verlauf',
          value:
            '`/score <t1> <t2>` — Ergebnis eintragen\n' +
            '`/leaderboard` — Win/Loss Rangliste\n' +
            '`/history [anzahl]` — Match-Verlauf anzeigen',
        },
        {
          name: '🗺️ Map Pool',
          value:
            '`/map` — Zufällige Map auswählen\n' +
            '`/addmap <name>` — Map hinzufügen\n' +
            '`/removemap <name>` — Map entfernen',
        },
        {
          name: '🔧 Sonstiges',
          value:
            '`/queue` — Queue-Mitglieder anzeigen\n' +
            '`/clearqueue` — Queue leeren\n' +
            '`/coinflip` — Münze werfen\n' +
            '`/ping` — Bot-Latenz prüfen',
        },
      );
    return interaction.reply({ embeds: [embed] });
  }

  // ── /queue ───────────────────────────────────────────────────────────
  if (cmd === 'queue') {
    const queueCh = getVC(guild, 'queue');
    if (!queueCh) return interaction.reply('❌ Queue Channel nicht gefunden!');
    const members = Array.from(queueCh.members.filter((m) => !m.user.bot).values());
    if (members.length === 0) return interaction.reply('ℹ️ Queue ist leer.');
    const list = members.map((m, i) => `${i + 1}. **${m.displayName}**`).join('\n');
    return interaction.reply(`📋 **Queue (${members.length} Spieler):**\n${list}`);
  }

  // ── /clearqueue ──────────────────────────────────────────────────────
  if (cmd === 'clearqueue') {
    const queueCh = getVC(guild, 'queue');
    if (!queueCh) return interaction.reply('❌ Queue Channel nicht gefunden!');
    const members = Array.from(queueCh.members.filter((m) => !m.user.bot).values());
    if (members.length === 0) return interaction.reply('ℹ️ Queue ist bereits leer.');

    const lobby = guild.channels.cache.find(
      (c) =>
        ['general', 'allgemein', 'lobby', 'wartezimmer'].includes(c.name.toLowerCase()) &&
        c.type === ChannelType.GuildVoice,
    );

    for (const m of members) {
      try {
        if (lobby) await m.voice.setChannel(lobby);
        else await m.voice.disconnect();
      } catch {}
    }
    return interaction.reply(`✅ **${members.length}** Spieler aus der Queue entfernt.`);
  }

  // ── /coinflip ────────────────────────────────────────────────────────
  if (cmd === 'coinflip') {
    return interaction.reply(`🪙 **${Math.random() < 0.5 ? '🟡 Kopf' : '⚪ Zahl'}!**`);
  }

  // ── /map ─────────────────────────────────────────────────────────────
  if (cmd === 'map') {
    if (mapPool.length === 0) return interaction.reply('❌ Keine Maps im Pool! Nutze `/addmap`.');
    const picked = mapPool[Math.floor(Math.random() * mapPool.length)];
    return interaction.reply(`🗺️ **Map: ${picked}**\n_Pool: ${mapPool.join(', ')}_`);
  }

  // ── /addmap ──────────────────────────────────────────────────────────
  if (cmd === 'addmap') {
    const name = interaction.options.getString('name').trim();
    if (mapPool.some((m) => m.toLowerCase() === name.toLowerCase())) {
      return interaction.reply(`❌ **${name}** ist bereits im Pool.`);
    }
    mapPool.push(name);
    return interaction.reply(`✅ **${name}** hinzugefügt.\n_Pool: ${mapPool.join(', ')}_`);
  }

  // ── /removemap ───────────────────────────────────────────────────────
  if (cmd === 'removemap') {
    const name = interaction.options.getString('name').trim();
    const idx = mapPool.findIndex((m) => m.toLowerCase() === name.toLowerCase());
    if (idx === -1) return interaction.reply(`❌ **${name}** nicht im Pool gefunden.`);
    mapPool.splice(idx, 1);
    return interaction.reply(
      `✅ **${name}** entfernt.\n_Pool: ${mapPool.length ? mapPool.join(', ') : 'leer'}_`,
    );
  }

  // ── /teams ───────────────────────────────────────────────────────────
  if (cmd === 'teams') {
    const queueCh = getVC(guild, 'queue');
    const team1Ch = getVC(guild, 'team 1');
    const team2Ch = getVC(guild, 'team 2');
    if (!queueCh || !team1Ch || !team2Ch) return interaction.reply('❌ Queue oder Team Channels fehlen!');

    const members = shuffle(Array.from(queueCh.members.filter((m) => !m.user.bot).values()));
    if (members.length < 2) return interaction.reply('❌ Zu wenig Spieler in der Queue!');

    const size1 = Math.floor(members.length / 2);
    const size2 = members.length - size1;
    const t1 = members.slice(0, size1);
    const t2 = members.slice(size1);

    for (const m of t1) await m.voice.setChannel(team1Ch);
    for (const m of t2) await m.voice.setChannel(team2Ch);

    recordTeams(t1, t2);
    draft = null;

    const embed = new EmbedBuilder()
      .setTitle(`🎮 Teams erstellt (${size1}v${size2})`)
      .setColor(0x57f287)
      .addFields(
        { name: '🔵 Team 1', value: t1.map((m) => m.displayName).join('\n'), inline: true },
        { name: '🔴 Team 2', value: t2.map((m) => m.displayName).join('\n'), inline: true },
      );
    return interaction.reply({ embeds: [embed] });
  }

  // ── /reset ───────────────────────────────────────────────────────────
  if (cmd === 'reset') {
    const queueCh = getVC(guild, 'queue');
    const team1Ch = getVC(guild, 'team 1');
    const team2Ch = getVC(guild, 'team 2');
    if (!queueCh || !team1Ch || !team2Ch) return interaction.reply('❌ Queue oder Team Channels fehlen!');

    const all = [
      ...Array.from(team1Ch.members.filter((m) => !m.user.bot).values()),
      ...Array.from(team2Ch.members.filter((m) => !m.user.bot).values()),
    ];
    if (all.length === 0) return interaction.reply('ℹ️ Keine Spieler in den Teams.');

    for (const m of all) await m.voice.setChannel(queueCh);
    draft = null;
    lastTeam1 = [];
    lastTeam2 = [];

    return interaction.reply(`🔄 **${all.length}** Spieler zurück in Queue.`);
  }

  // ── /shuffle ─────────────────────────────────────────────────────────
  if (cmd === 'shuffle') {
    const team1Ch = getVC(guild, 'team 1');
    const team2Ch = getVC(guild, 'team 2');
    if (!team1Ch || !team2Ch) return interaction.reply('❌ Team Channels fehlen!');

    const all = shuffle([
      ...Array.from(team1Ch.members.filter((m) => !m.user.bot).values()),
      ...Array.from(team2Ch.members.filter((m) => !m.user.bot).values()),
    ]);
    if (all.length < 2) return interaction.reply('❌ Zu wenig Spieler in den Team Channels!');

    const size1 = Math.floor(all.length / 2);
    const size2 = all.length - size1;
    const t1 = all.slice(0, size1);
    const t2 = all.slice(size1);

    for (const m of t1) await m.voice.setChannel(team1Ch);
    for (const m of t2) await m.voice.setChannel(team2Ch);

    recordTeams(t1, t2);
    draft = null;

    const embed = new EmbedBuilder()
      .setTitle(`🔀 Teams neu gemischt (${size1}v${size2})`)
      .setColor(0xfee75c)
      .addFields(
        { name: '🔵 Team 1', value: t1.map((m) => m.displayName).join('\n'), inline: true },
        { name: '🔴 Team 2', value: t2.map((m) => m.displayName).join('\n'), inline: true },
      );
    return interaction.reply({ embeds: [embed] });
  }

  // ── /draft ───────────────────────────────────────────────────────────
  if (cmd === 'draft') {
    const queueCh = getVC(guild, 'queue');
    const team1Ch = getVC(guild, 'team 1');
    const team2Ch = getVC(guild, 'team 2');
    if (!queueCh || !team1Ch || !team2Ch) return interaction.reply('❌ Queue oder Team Channels fehlen!');

    const members = Array.from(queueCh.members.filter((m) => !m.user.bot).values());
    if (members.length < 2) return interaction.reply('❌ Mindestens 2 Spieler in der Queue erforderlich!');

    const [cap1, cap2, ...remaining] = shuffle(members);

    await cap1.voice.setChannel(team1Ch);
    await cap2.voice.setChannel(team2Ch);

    draft = {
      captains: [
        { member: cap1, channel: team1Ch, teamNum: 1, members: [cap1] },
        { member: cap2, channel: team2Ch, teamNum: 2, members: [cap2] },
      ],
      currentIdx: 0,
      remaining,
    };

    const embed = new EmbedBuilder()
      .setTitle('🧢 Captain\'s Draft gestartet!')
      .setColor(0xeb459e)
      .addFields(
        { name: '🔵 Captain Team 1', value: cap1.displayName, inline: true },
        { name: '🔴 Captain Team 2', value: cap2.displayName, inline: true },
        {
          name: `👥 Verfügbare Spieler (${remaining.length})`,
          value: remaining.length > 0 ? remaining.map((m, i) => `${i + 1}. ${m.displayName}`).join('\n') : '_Keine weiteren Spieler_',
        },
        { name: '▶️ Dran', value: `**${cap1.displayName}** — nutze \`/pick @spieler\`` },
      );
    return interaction.reply({ embeds: [embed] });
  }

  // ── /pick ────────────────────────────────────────────────────────────
  if (cmd === 'pick') {
    if (!draft) return interaction.reply('❌ Kein aktiver Draft! Nutze `/draft` um zu starten.');

    const currentCap = draft.captains[draft.currentIdx];
    if (interaction.user.id !== currentCap.member.id) {
      return interaction.reply(`❌ Du bist nicht dran! **${currentCap.member.displayName}** ist am Zug.`);
    }

    const picked = interaction.options.getMember('player');
    if (!picked) return interaction.reply('❌ Spieler nicht gefunden!');

    const idx = draft.remaining.findIndex((m) => m.id === picked.id);
    if (idx === -1) return interaction.reply(`❌ **${picked.displayName}** ist nicht in der Pick-Liste!`);

    draft.remaining.splice(idx, 1);
    currentCap.members.push(picked);

    try {
      await picked.voice.setChannel(currentCap.channel);
    } catch {
      return interaction.reply(`❌ **${picked.displayName}** ist nicht in einem Voice Channel!`);
    }

    // Draft complete
    if (draft.remaining.length === 0) {
      const t1 = draft.captains[0].members;
      const t2 = draft.captains[1].members;
      recordTeams(t1, t2);
      draft = null;

      const embed = new EmbedBuilder()
        .setTitle('✅ Draft abgeschlossen!')
        .setColor(0x57f287)
        .addFields(
          { name: `🔵 Team 1 (${t1.length})`, value: t1.map((m) => m.displayName).join('\n'), inline: true },
          { name: `🔴 Team 2 (${t2.length})`, value: t2.map((m) => m.displayName).join('\n'), inline: true },
        );
      return interaction.reply({ embeds: [embed] });
    }

    // Next captain's turn (alternating)
    draft.currentIdx = draft.currentIdx === 0 ? 1 : 0;
    const nextCap = draft.captains[draft.currentIdx];

    const embed = new EmbedBuilder()
      .setTitle(`✅ ${picked.displayName} gepickt!`)
      .setColor(0x5865f2)
      .addFields(
        {
          name: `🔵 Team 1 (${draft.captains[0].members.length})`,
          value: draft.captains[0].members.map((m) => m.displayName).join('\n'),
          inline: true,
        },
        {
          name: `🔴 Team 2 (${draft.captains[1].members.length})`,
          value: draft.captains[1].members.map((m) => m.displayName).join('\n'),
          inline: true,
        },
        {
          name: `👥 Noch verfügbar (${draft.remaining.length})`,
          value: draft.remaining.map((m, i) => `${i + 1}. ${m.displayName}`).join('\n'),
        },
        { name: '▶️ Dran', value: `**${nextCap.member.displayName}** — nutze \`/pick @spieler\`` },
      );
    return interaction.reply({ embeds: [embed] });
  }

  // ── /swap ────────────────────────────────────────────────────────────
  if (cmd === 'swap') {
    const team1Ch = getVC(guild, 'team 1');
    const team2Ch = getVC(guild, 'team 2');
    if (!team1Ch || !team2Ch) return interaction.reply('❌ Team Channels fehlen!');

    const p1 = interaction.options.getMember('player1');
    const p2 = interaction.options.getMember('player2');
    if (!p1 || !p2) return interaction.reply('❌ Spieler nicht gefunden!');

    const p1t1 = team1Ch.members.has(p1.id);
    const p1t2 = team2Ch.members.has(p1.id);
    const p2t1 = team1Ch.members.has(p2.id);
    const p2t2 = team2Ch.members.has(p2.id);

    if (!(p1t1 || p1t2) || !(p2t1 || p2t2)) {
      return interaction.reply('❌ Beide Spieler müssen in Team 1 oder Team 2 sein!');
    }
    if ((p1t1 && p2t1) || (p1t2 && p2t2)) {
      return interaction.reply('❌ Spieler sind bereits im selben Team!');
    }

    await p1.voice.setChannel(p1t1 ? team2Ch : team1Ch);
    await p2.voice.setChannel(p2t1 ? team2Ch : team1Ch);

    return interaction.reply(`🔁 **${p1.displayName}** ↔ **${p2.displayName}** getauscht!`);
  }

  // ── /sub ─────────────────────────────────────────────────────────────
  if (cmd === 'sub') {
    const queueCh = getVC(guild, 'queue');
    const team1Ch = getVC(guild, 'team 1');
    const team2Ch = getVC(guild, 'team 2');
    if (!queueCh || !team1Ch || !team2Ch) return interaction.reply('❌ Queue oder Team Channels fehlen!');

    const subIn = interaction.options.getMember('player');
    const replace = interaction.options.getMember('replace');
    if (!subIn || !replace) return interaction.reply('❌ Spieler nicht gefunden!');

    if (!queueCh.members.has(subIn.id)) {
      return interaction.reply(`❌ **${subIn.displayName}** ist nicht in der Queue!`);
    }

    const replaceT1 = team1Ch.members.has(replace.id);
    const replaceT2 = team2Ch.members.has(replace.id);
    if (!replaceT1 && !replaceT2) {
      return interaction.reply(`❌ **${replace.displayName}** ist in keinem Team!`);
    }

    await subIn.voice.setChannel(replaceT1 ? team1Ch : team2Ch);
    await replace.voice.setChannel(queueCh);

    return interaction.reply(`🔄 **${subIn.displayName}** ersetzt **${replace.displayName}**!`);
  }

  // ── /score ───────────────────────────────────────────────────────────
  if (cmd === 'score') {
    if (lastTeam1.length === 0 || lastTeam2.length === 0) {
      return interaction.reply('❌ Keine Teams gefunden. Nutze zuerst `/teams` oder `/draft`!');
    }

    const s1 = interaction.options.getInteger('team1');
    const s2 = interaction.options.getInteger('team2');
    const draw = s1 === s2;
    const team1Won = s1 > s2;

    for (const p of lastTeam1) {
      ensureStat(p.id, p.name);
      if (!draw) team1Won ? stats.get(p.id).wins++ : stats.get(p.id).losses++;
    }
    for (const p of lastTeam2) {
      ensureStat(p.id, p.name);
      if (!draw) team1Won ? stats.get(p.id).losses++ : stats.get(p.id).wins++;
    }

    matchHistory.push({
      team1: [...lastTeam1],
      team2: [...lastTeam2],
      score1: s1,
      score2: s2,
      date: new Date().toLocaleString('de-DE'),
    });

    const winner = draw ? '🤝 Unentschieden' : team1Won ? '🔵 Team 1 gewinnt!' : '🔴 Team 2 gewinnt!';
    const color = draw ? 0xfee75c : team1Won ? 0x5865f2 : 0xed4245;

    const embed = new EmbedBuilder()
      .setTitle('📊 Ergebnis gespeichert')
      .setColor(color)
      .addFields(
        { name: '🔵 Team 1', value: lastTeam1.map((p) => p.name).join('\n'), inline: true },
        { name: `${s1} — ${s2}`, value: winner, inline: true },
        { name: '🔴 Team 2', value: lastTeam2.map((p) => p.name).join('\n'), inline: true },
      )
      .setFooter({ text: `Match #${matchHistory.length}` });
    return interaction.reply({ embeds: [embed] });
  }

  // ── /leaderboard ─────────────────────────────────────────────────────
  if (cmd === 'leaderboard') {
    const players = [...stats.values()].filter((s) => s.wins + s.losses > 0);
    if (players.length === 0) return interaction.reply('ℹ️ Noch keine Stats — spiele ein Match und nutze `/score`!');

    const sorted = players.sort((a, b) => {
      const aWr = a.wins / (a.wins + a.losses);
      const bWr = b.wins / (b.wins + b.losses);
      return bWr - aWr || b.wins - a.wins;
    });

    const medals = ['🥇', '🥈', '🥉'];
    const rows = sorted
      .slice(0, 10)
      .map((s, i) => {
        const total = s.wins + s.losses;
        const wr = Math.round((s.wins / total) * 100);
        return `${medals[i] ?? `${i + 1}.`} **${s.name}** — ${s.wins}W / ${s.losses}L **(${wr}%)**`;
      })
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle('🏆 Leaderboard')
      .setColor(0xf1c40f)
      .setDescription(rows)
      .setFooter({ text: `${matchHistory.length} Matches gespielt insgesamt` });
    return interaction.reply({ embeds: [embed] });
  }

  // ── /history ─────────────────────────────────────────────────────────
  if (cmd === 'history') {
    if (matchHistory.length === 0) return interaction.reply('ℹ️ Noch keine Matches gespielt!');

    const count = Math.min(interaction.options.getInteger('count') ?? 5, 10);
    const recent = [...matchHistory].reverse().slice(0, count);

    const rows = recent
      .map((m, i) => {
        const result =
          m.score1 === m.score2 ? 'Unentschieden' : m.score1 > m.score2 ? '🔵 Team 1' : '🔴 Team 2';
        const t1 = m.team1.map((p) => p.name).join(', ');
        const t2 = m.team2.map((p) => p.name).join(', ');
        return `**${i + 1}. ${m.score1}:${m.score2}** — ${result}\n🔵 ${t1}\n🔴 ${t2}\n_${m.date}_`;
      })
      .join('\n\n');

    const embed = new EmbedBuilder()
      .setTitle(`📋 Match History (letzte ${recent.length})`)
      .setColor(0x99aab5)
      .setDescription(rows);
    return interaction.reply({ embeds: [embed] });
  }
});

client.on('error', (err) => console.error('Discord client error:', err));
client.login(token);
