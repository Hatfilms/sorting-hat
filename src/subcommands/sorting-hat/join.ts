import {
  CacheType,
  ChatInputCommandInteraction,
  GuildMember,
} from 'discord.js';

const houseList = ['Smytherin', 'Rosslepuff', 'Trottindor', 'CreggleClaw'];

import { ClientInt } from '../../utils/ClientInt';
import BaseSubCommandExecutor from '../../utils/BaseSubcommandExecutor';
import { Group } from '../../utils/BaseSlashSubCommand';

class Join extends BaseSubCommandExecutor {
  constructor(baseCommand: string, group: Group) {
    super(baseCommand, group, 'join');
  }

  async run(
    client: ClientInt,
    interaction: ChatInputCommandInteraction<CacheType>,
  ) {
    const member = interaction.member as GuildMember;
    const house = interaction.options.getString('house', true);

    // check if there is a role with the house name
    const role = member.guild.roles.cache.find(
      (role) => role.name.toLowerCase() === house.toLowerCase(),
    );

    if (!role) {
      await interaction.reply({
        content: `There is no house with the name ${house}`,
        ephemeral: true,
      });
      return;
    }

    // check if the house is in the list of houses
    if (!houseList.includes(house)) {
      await interaction.reply({
        content: `There is no house with the name ${house}`,
        ephemeral: true,
      });
      return;
    }

    // check if the member already has a house role
    const houseRole = member.roles.cache.find((role) => role.name === house);

    if (houseRole) {
      await interaction.reply({
        content: `You are already in a house: ${houseRole.name}`,
        ephemeral: true,
      });
      return;
    }

    // add the house role
    await member.roles.add(role);
    client.invalidateHouseRankingCache(interaction.guildId);

    await interaction.reply({
      content: `You have been added to the house: ${house}`,
      ephemeral: true,
    });
  }
}

export default Join;
