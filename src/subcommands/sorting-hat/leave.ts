import {
  ActionRowBuilder,
  CacheType,
  ChatInputCommandInteraction,
  GuildMember,
} from 'discord.js';

import { ClientInt } from '../../utils/ClientInt';
import BaseSubCommandExecutor from '../../utils/BaseSubcommandExecutor';
import { Group } from '../../utils/BaseSlashSubCommand';

class Leave extends BaseSubCommandExecutor {
  constructor(baseCommand: string, group: Group) {
    super(baseCommand, group, 'leave');
  }

  async run(
    client: ClientInt,
    interaction: ChatInputCommandInteraction<CacheType>,
  ) {
    const member = interaction.member as GuildMember;

    // check if the member has a house role
    const houseRole = member.roles.cache.find((role) =>
      ['Smytherin', 'Rosslepuff', 'Trottindor', 'RavenCraig'].includes(
        role.name,
      ),
    );

    if (!houseRole) {
      await interaction.reply({
        content: 'You are not in a house.',
        ephemeral: true,
      });
      return;
    }

    // remove the house role
    await member.roles.remove(houseRole);
    client.invalidateHouseRankingCache(interaction.guildId);

    await interaction.reply({
      content: `You have left the house: ${houseRole.name}`,
      ephemeral: true,
    });
  }
}

export default Leave;
