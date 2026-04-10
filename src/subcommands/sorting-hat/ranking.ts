import {
  CacheType,
  ChatInputCommandInteraction,
  Embed,
  Guild,
  Role,
} from 'discord.js';

import { ClientInt, HouseRankingResult } from '../../utils/ClientInt';
import BaseSubCommandExecutor from '../../utils/BaseSubcommandExecutor';
import { Group } from '../../utils/BaseSlashSubCommand';

const houseList = [
  '1216014611028115472',
  '1216014648252432434',
  '1216014899520737352',
  '1216014857149612102',
];

const buildRankingEmbed = (houseCount: HouseRankingResult[]) => {
  return {
    title: 'Ranking of Houses by Members Count',
    color: 0x00ff00,
    fields: houseCount.map((house, index) => ({
      name: `${index + 1}. ${house.roleName}`,
      value: `Members: ${house.membersCount}`,
    })),
    timestamp: new Date().toISOString(),
  } as Embed;
};

const getHouseRanking = async (guild: Guild): Promise<HouseRankingResult[]> => {
  const [allRoles, members] = await Promise.all([
    Promise.all(
      houseList.map((roleId) => guild.roles.fetch(roleId).catch(() => null)),
    ),
    guild.members.cache.size >= guild.memberCount
      ? Promise.resolve(guild.members.cache)
      : guild.members.fetch(),
  ]);

  const roles = allRoles.filter((role): role is Role => role !== null);
  const memberCountsByRoleId = new Map<string, number>(
    roles.map((role) => [role.id, 0]),
  );

  for (const member of members.values()) {
    for (const roleId of houseList) {
      if (!member.roles.cache.has(roleId)) {
        continue;
      }

      const currentCount = memberCountsByRoleId.get(roleId) ?? 0;
      memberCountsByRoleId.set(roleId, currentCount + 1);
    }
  }

  return roles
    .map((role) => ({
      roleName: role.name,
      membersCount: memberCountsByRoleId.get(role.id) ?? 0,
    }))
    .sort((a, b) => b.membersCount - a.membersCount);
};

class Ranking extends BaseSubCommandExecutor {
  constructor(baseCommand: string, group: Group) {
    super(baseCommand, group, 'ranking');
  }

  async run(
    client: ClientInt,
    interaction: ChatInputCommandInteraction<CacheType>,
  ) {
    await interaction.deferReply({ ephemeral: false });

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({
        content: 'This command can only be used in a server.',
      });
      return;
    }

    const cachedRanking = client.getHouseRankingCache(guild.id);
    if (cachedRanking) {
      await interaction.editReply({
        embeds: [buildRankingEmbed(cachedRanking)],
      });
      return;
    }

    let inFlight = client.getHouseRankingInFlight(guild.id);
    if (!inFlight) {
      inFlight = getHouseRanking(guild);
      client.setHouseRankingInFlight(guild.id, inFlight);
    }

    try {
      const ranking = await inFlight;
      client.setHouseRankingCache(guild.id, ranking);

      await interaction.editReply({ embeds: [buildRankingEmbed(ranking)] });
    } catch (error) {
      console.error('Failed to build house ranking', error);
      await interaction.editReply({
        content:
          "I couldn't build the ranking right now. Please try again shortly.",
      });
    } finally {
      client.clearHouseRankingInFlight(guild.id);
    }
  }
}

export default Ranking;
