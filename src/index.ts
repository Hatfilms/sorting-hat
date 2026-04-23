import { GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
import 'dotenv/config';
import { ClientInt } from './utils/ClientInt';
import { registerSubCommands } from './utils/registry';
import { handleButtonInteraction, handleSubcommand } from './utils/Helpers';
import { registerScamReviewHandlers } from './handlers/scam-review';

// Get environment variables
const { CLIENT_ID, GUILD_ID, BOT_TOKEN } = process.env;

// Create a new Discord client instance
const client = new ClientInt({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessagePolls,
  ],
  partials: [
    Partials.GuildMember,
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
  ],
});

// Create a new REST API instance and set the token
const rest = new REST({ version: '10' }).setToken(BOT_TOKEN!); // **** Means this won't complain about possible undefined.

// Log when the client is ready
client.once('ready', () => console.log(`${client.user?.tag} logged in`));

// Handle incoming interactions
client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const cmd = await client.commands.get(interaction.commandName);
    const subcommandName = interaction.options.getSubcommand(false);

    if (subcommandName) {
      handleSubcommand(client, interaction, subcommandName);
    } else if (cmd) {
      cmd.run(client, interaction);
    } else {
      await interaction.reply({
        content: 'This command is not registered yet!',
        ephemeral: true,
      });
      console.log('No command found');
    }
  } else if (interaction.isButton()) {
    handleButtonInteraction(client, interaction);
  }
});

//Handle Member Join, add a random house role to the member
client.on('guildMemberAdd', async (member) => {
  const houseList = ['Smytherin', 'Rosslepuff', 'Trottindor', 'CreggleClaw'];
  const randomHouse = houseList[Math.floor(Math.random() * houseList.length)];

  const role = member.guild.roles.cache.find(
    (role) => role.name.toLowerCase() === randomHouse.toLowerCase(),
  );

  if (role) {
    await member.roles.add(role);
    client.invalidateHouseRankingCache(member.guild.id);
  }
});

registerScamReviewHandlers(client);

// Main function
const main = async () => {
  try {
    // Check if environment variables are set
    if (!CLIENT_ID || !GUILD_ID || !BOT_TOKEN)
      throw new Error('Incomplete .env config!');

    // Register commands and subcommands
    // await registerCommands(client, '../handlers');
    await registerSubCommands(client);

    // Get command and subcommand JSON
    const commandsJSON = client.commands
      .filter((cmd) => typeof cmd.getCommandJSON === 'function')
      .map((cmd) => cmd.getCommandJSON());

    const subCommandsJSON = client.slashSubcommands.map((cmd) =>
      cmd.getCommandJSON(),
    );

    // Register commands and subcommands with Discord API
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [...commandsJSON, ...subCommandsJSON],
    });

    // Log in to Discord
    await client.login(BOT_TOKEN);
  } catch (error) {
    console.error(error);
  }
};

// Call main function
main().catch(console.error);
