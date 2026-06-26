import {
  Attachment,
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  GuildBasedChannel,
  GuildTextBasedChannel,
  Message,
  PermissionFlagsBits,
} from "discord.js";
import { inspectImage } from "../utils/ImageTextInspector";
import {
  recordImagePost,
  getCrossChannelHits,
  CrossChannelHit,
} from "../utils/sqlite";

type PendingReview = {
  logMessageId: string;
  userId: string;
  userTag: string;
  guildId: string;
  originalChannelId: string;
};

const LOG_CHANNEL_ID = "342772823636443137";
const MOD_ROLE_ID = "342774444235816971";
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const getTextChannel = async (
  client: Client,
  channelId: string,
): Promise<GuildTextBasedChannel | null> => {
  const channel = (await client.channels
    .fetch(channelId)
    .catch(() => null)) as GuildBasedChannel | null;

  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    return null;
  }

  return channel;
};

const isImageAttachment = (attachment: Attachment) => {
  if (attachment.contentType?.startsWith("image/")) {
    return true;
  }

  const name = attachment.name?.toLowerCase() ?? "";
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
};

const truncate = (value: string, maxLength = 1024) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
};

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
};

const deleteReviewMessage = async (
  channel: GuildTextBasedChannel,
  review: PendingReview,
) => {
  const reviewMessage = await channel.messages
    .fetch(review.logMessageId)
    .catch(() => null);

  if (reviewMessage) {
    await reviewMessage.delete().catch(() => null);
  }
};

const notifyUserOfRemoval = async (client: Client, userId: string) => {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) {
    return;
  }

  await user
    .send(
      "Your recent image post was removed pending moderator review for potential scam/spam content. " +
        "If this was a mistake, a moderator will review and restore it shortly.",
    )
    .catch(() => null);
};

export const registerScamReviewHandlers = (client: Client) => {
  const pendingReviewsByMessage = new Map<string, PendingReview>();
  const pendingReviewMessageByUser = new Map<string, string>();
  const creatingReviewUsers = new Set<string>();

  const clearPendingReview = (review: PendingReview) => {
    pendingReviewsByMessage.delete(review.logMessageId);
    pendingReviewMessageByUser.delete(review.userId);
  };

  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot || !message.inGuild()) {
      return;
    }

    const imageAttachments = [...message.attachments.values()].filter(
      isImageAttachment,
    );

    if (imageAttachments.length === 0) {
      return;
    }

    if (
      pendingReviewMessageByUser.has(message.author.id) ||
      creatingReviewUsers.has(message.author.id)
    ) {
      return;
    }

    let scamKeywords: string[] = [];
    let crossChannelHits: CrossChannelHit[] = [];

    for (const attachment of imageAttachments) {
      try {
        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        const inspection = await inspectImage(buffer);

        if (inspection.hasScamIndicators) {
          scamKeywords.push(...inspection.matchedKeywords);
        }

        recordImagePost(
          message.author.id,
          inspection.imageHash,
          message.channelId,
          message.id,
        );

        const hits = getCrossChannelHits(
          message.author.id,
          inspection.imageHash,
        );

        if (hits.length > 0) {
          crossChannelHits = hits;
        }
      } catch (error) {
        console.error("Image inspection error:", error);
      }
    }

    const isCrossChannelSpam = crossChannelHits.length > 0;
    const isScam = scamKeywords.length > 0;

    if (!isScam && !isCrossChannelSpam) {
      return;
    }

    creatingReviewUsers.add(message.author.id);

    try {
      const logChannel = await getTextChannel(client, LOG_CHANNEL_ID);
      if (!logChannel) {
        return;
      }

      const member = await message.guild.members
        .fetch(message.author.id)
        .catch(() => null);

      if (member) {
        await member
          .timeout(
            DEFAULT_TIMEOUT_MS,
            isScam
              ? "Auto-timeout pending scam review (OCR keyword match)"
              : "Auto-timeout pending scam review (cross-channel image spam)",
          )
          .catch(() => null);
      }

      const reasonValue = isScam
        ? `OCR keyword match: ${[...new Set(scamKeywords)].join(", ")}`
        : `Cross-channel spam: same image posted in ${new Set(crossChannelHits.map((hit) => hit.channelId)).size} channels within 60s`;

      const embed = new EmbedBuilder()
        .setTitle("Possible scam/spam detected")
        .setColor(0xff6b35)
        .addFields(
          {
            name: "User",
            value: `${message.author.tag} (${message.author.id})`,
          },
          {
            name: "Channel",
            value: `<#${message.channelId}>`,
          },
          {
            name: "Detection reason",
            value: truncate(reasonValue),
          },
          {
            name: "Content",
            value: truncate(message.content || "*(no text)*"),
          },
          {
            name: "Actions",
            value:
              "✅ = Safe (dismiss + remove timeout)\n🔨 = Ban user\n⏰ = Extend timeout 24h\n👁️ = Mark as reviewed",
          },
        )
        .addFields({
          name: "Auto Action",
          value:
            "User has been timed out immediately pending moderator review.",
        })
        .setFooter({ text: "React below to take action" })
        .setTimestamp();

      const logMessage = await logChannel.send({
        content: `🚨 <@&${MOD_ROLE_ID}> - Review needed`,
        embeds: [embed],
        files: imageAttachments.map((attachment) => attachment.url),
      });

      await logMessage.react("✅");
      await logMessage.react("🔨");
      await logMessage.react("⏰");
      await logMessage.react("👁️");

      const review: PendingReview = {
        logMessageId: logMessage.id,
        userId: message.author.id,
        userTag: message.author.tag,
        guildId: message.guildId,
        originalChannelId: message.channelId,
      };

      pendingReviewsByMessage.set(logMessage.id, review);
      pendingReviewMessageByUser.set(message.author.id, logMessage.id);

      await notifyUserOfRemoval(client, message.author.id);

      if (message.deletable) {
        await message.delete().catch(() => null);
      }

      if (isCrossChannelSpam) {
        const otherHits = crossChannelHits.filter(
          (hit) => hit.messageId !== message.id,
        );

        for (const hit of otherHits) {
          const channel = await getTextChannel(client, hit.channelId);
          if (!channel) {
            continue;
          }

          const duplicateMessage = await channel.messages
            .fetch(hit.messageId)
            .catch(() => null);

          if (duplicateMessage?.deletable) {
            await duplicateMessage.delete().catch(() => null);
          }
        }
      }
    } catch (error) {
      console.error("Scam handler error:", error);
    } finally {
      creatingReviewUsers.delete(message.author.id);
    }
  });

  client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) {
      return;
    }

    if (user.partial) {
      try {
        await user.fetch();
      } catch {
        return;
      }
    }

    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }

    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch {
        return;
      }
    }

    const review = pendingReviewsByMessage.get(reaction.message.id);
    if (!review) {
      return;
    }

    const guild =
      client.guilds.cache.get(review.guildId) ??
      (await client.guilds.fetch(review.guildId).catch(() => null));

    if (!guild) {
      return;
    }

    const reactor = await guild.members.fetch(user.id).catch(() => null);
    if (!reactor) {
      return;
    }

    const isAllowedModerator =
      reactor.roles.cache.has(MOD_ROLE_ID) ||
      reactor.permissions.has(PermissionFlagsBits.Administrator);

    if (!isAllowedModerator) {
      return;
    }

    const logChannel = await getTextChannel(client, LOG_CHANNEL_ID);
    if (!logChannel) {
      return;
    }

    const { userId, userTag } = review;
    const moderatorTag = user.tag ?? user.id;

    try {
      switch (reaction.emoji.name) {
        case "✅": {
          const member = await guild.members.fetch(userId).catch(() => null);
          if (member) {
            await member
              .timeout(null, `Dismissed by ${moderatorTag}`)
              .catch(() => null);
          }

          const logMessage = await logChannel.messages
            .fetch(review.logMessageId)
            .catch(() => null);
          const logAttachments = logMessage
            ? [...logMessage.attachments.values()]
            : [];

          const repostFiles: AttachmentBuilder[] = [];
          for (const attachment of logAttachments) {
            try {
              const response = await fetch(attachment.url);
              const buffer = Buffer.from(await response.arrayBuffer());
              repostFiles.push(
                new AttachmentBuilder(buffer, {
                  name: attachment.name ?? "image.png",
                }),
              );
            } catch (error) {
              console.error("Failed to download attachment for repost:", error);
            }
          }

          await deleteReviewMessage(logChannel, review);
          await logChannel.send(
            `✅ ${userTag}'s post marked as safe by <@${user.id}>. Timeout removed and case dismissed.`,
          );

          if (repostFiles.length > 0) {
            const originalChannel = await getTextChannel(
              client,
              review.originalChannelId,
            );

            if (originalChannel) {
              await originalChannel
                .send({
                  content: `Reposted on behalf of <@${userId}> (cleared by <@${user.id}>):`,
                  files: repostFiles,
                })
                .catch(() => null);
            }
          }

          clearPendingReview(review);
          break;
        }

        case "🔨": {
          const existingBan = await guild.bans.fetch(userId).catch(() => null);
          if (existingBan) {
            await deleteReviewMessage(logChannel, review);
            await logChannel.send(
              `ℹ️ ${userTag} is already banned. Marking review resolved by <@${user.id}>.`,
            );
            clearPendingReview(review);
            break;
          }

          const member = await guild.members.fetch(userId).catch(() => null);
          if (member) {
            await member.ban({
              reason: `Scam post - banned by ${moderatorTag}`,
            });
            await deleteReviewMessage(logChannel, review);
            await logChannel.send(
              `🔨 ${userTag} has been banned by <@${user.id}>.`,
            );
          } else {
            await guild.members
              .ban(userId, {
                reason: `Scam post - banned by ${moderatorTag}`,
              })
              .catch(() => null);
            const bannedNow = await guild.bans.fetch(userId).catch(() => null);

            if (bannedNow) {
              await deleteReviewMessage(logChannel, review);
              await logChannel.send(
                `🔨 ${userTag} has been banned by <@${user.id}>.`,
              );
            } else {
              await logChannel.send(
                `⚠️ Could not ban ${userTag} - they may have already left the server or bot lacks permission.`,
              );
            }
          }

          clearPendingReview(review);
          break;
        }

        case "⏰": {
          const member = await guild.members.fetch(userId).catch(() => null);
          if (member) {
            await member.timeout(
              DEFAULT_TIMEOUT_MS,
              `Scam post - timeout extended by ${moderatorTag}`,
            );
            await logChannel.send(
              `⏰ ${userTag} timeout has been extended for 24 hours by <@${user.id}>.`,
            );
          } else {
            await logChannel.send(
              `⚠️ Could not time out ${userTag} - they may have already left the server.`,
            );
          }

          // Keep review open until dismissed or banned.
          break;
        }

        case "👁️": {
          await logChannel.send(
            `👁️ ${userTag}'s post has been reviewed by <@${user.id}>. Keeping under watch.`,
          );
          break;
        }

        default:
          break;
      }
    } catch (error) {
      console.error("Reaction action error:", error);
      await logChannel.send(`❌ Action failed: ${toErrorMessage(error)}`);
    }
  });
};
