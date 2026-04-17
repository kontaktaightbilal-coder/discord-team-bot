import { Client, GatewayIntentBits, ChannelType, REST, Routes } from 'discord.js';

const token = process.env.TOKEN;

if (!token) {
  console.error('ERROR: TOKEN environment variable is not set.');
  process.exit(1);
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('clientReady', async (c) => {
  console.log(`Bot online: ${c.user.tag}`);
  const commands = [
    { name: 'teams', description: 'Split players from Queue into Team 1 and Team 2' },
    { name: 'reset', description: 'Move all players from Team 1 and Team 2 back to Queue' },
    { name: 'shuffle', description: 'Re-randomize the existing teams without resetting' },
  ];
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
  console.log('Commands registered.');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const guild = interaction.guild;
  if (!guild) return interaction.reply('This command must be used in a server.');

  const getVC = (name) =>
    guild.channels.cache.find(
      (c) => c.name.toLowerCase() === name && c.type === ChannelType.GuildVoice
    );

  if (interaction.commandName === 'teams') {
    const queue = getVC('queue'), team1 = getVC('team 1'), team2 = getVC('team 2');
    if (!queue || !team1 || !team2) return interaction.reply('❌ Queue oder Team Channels fehlen!');
    const members = Array.from(queue.members.filter((m) => !m.user.bot).values());
    if (members.length < 2) return interaction.reply('Zu wenig Spieler!');
    if (members.length % 2 !== 0) return interaction.reply('Ungerade Anzahl!');
    const size = members.length / 2;
    const shuffled = shuffle(members);
    for (const m of shuffled.slice(0, size)) await m.voice.setChannel(team1);
    for (const m of shuffled.slice(size)) await m.voice.setChannel(team2);
    await interaction.reply(`🎮 Teams erstellt (${size}v${size})`);
  }

  if (interaction.commandName === 'reset') {
    const queue = getVC('queue'), team1 = getVC('team 1'), team2 = getVC('team 2');
    if (!queue || !team1 || !team2) return interaction.reply('❌ Queue oder Team Channels fehlen!');
    const all = [...team1.members.filter((m) => !m.user.bot).values(), ...team2.members.filter((m) => !m.user.bot).values()];
    if (all.length === 0) return interaction.reply('ℹ️ Keine Spieler in Team 1 oder Team 2.');
    for (const m of all) await m.voice.setChannel(queue);
    await interaction.reply(`🔄 ${all.length} Spieler zurück in Queue verschoben.`);
  }

  if (interaction.commandName === 'shuffle') {
    const team1 = getVC('team 1'), team2 = getVC('team 2');
    if (!team1 || !team2) return interaction.reply('❌ Team Channels fehlen!');
    const all = shuffle([...team1.members.filter((m) => !m.user.bot).values(), ...team2.members.filter((m) => !m.user.bot).values()]);
    if (all.length < 2) return interaction.reply('Zu wenig Spieler!');
    if (all.length % 2 !== 0) return interaction.reply('Ungerade Anzahl!');
    const size = all.length / 2;
    for (const m of all.slice(0, size)) await m.voice.setChannel(team1);
    for (const m of all.slice(size)) await m.voice.setChannel(team2);
    await interaction.reply(`🔀 Teams neu gemischt (${size}v${size})`);
  }
});

client.on('error', (err) => console.error('Discord client error:', err));
client.login(token);
