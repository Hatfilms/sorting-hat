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
import {
  hashImageBuffer,
  inspectImage,
  warmUpImageInspector,
} from "../utils/ImageTextInspector";
import {
  recordImagePost,
  getCrossChannelHits,
  getRapidImageOnlyHits,
  CrossChannelHit,
} from "../utils/sqlite";

type PendingReview = {
  logMessageId: string;
  userId: string;
  userTag: string;
  guildId: string;
  originalChannelId: string;
  suppressedCount: number;
};

type DownloadedAttachment = {
  attachment: Attachment;
  buffer: Buffer;
};

const LOG_CHANNEL_ID = "342772823636443137";
const MOD_ROLE_ID = "342774444235816971";
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SUPPRESSED_FIELD_NAME = "Additional posts removed";

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

const downloadAttachments = async (
  attachments: Attachment[],
): Promise<DownloadedAttachment[]> => {
  const results = await Promise.all(
    attachments.map(async (attachment) => {
      try {
        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        return { attachment, buffer };
      } catch (error) {
        console.error("Attachment download error:", error);
        return null;
      }
    }),
  );

  return results.filter((result): result is DownloadedAttachment => !!result);
};

type SpamDetection = {
  summary: string;
  reason: string;
  duplicateHits: CrossChannelHit[];
};

// Checks the cheap hash-based rules before falling back to OCR. Returns
// null when nothing looks like spam.
const detectSpam = async (
  message: Message<true>,
  downloaded: DownloadedAttachment[],
): Promise<SpamDetection | null> => {
  const hasText = message.content.trim().length > 0;

  const imageHashes = downloaded.map(({ buffer }) => hashImageBuffer(buffer));
  for (const imageHash of imageHashes) {
    recordImagePost(
      message.author.id,
      imageHash,
      message.channelId,
      message.id,
      message.createdTimestamp,
      hasText,
    );
  }

  // Rule 1: image-only posts in 2+ channels within a second.
  if (!hasText) {
    const rapidHits = getRapidImageOnlyHits(
      message.author.id,
      message.createdTimestamp,
    );

    if (rapidHits.length > 0) {
      const channelCount = new Set(rapidHits.map((hit) => hit.channelId)).size;
      return {
        summary: "rapid multi-channel image posts",
        reason: `Rapid image spam: image-only posts in ${channelCount} channels within 1s`,
        duplicateHits: rapidHits,
      };
    }
  }

  // Rule 2: the same image in 3+ channels within 60s.
  for (const imageHash of imageHashes) {
    const hits = getCrossChannelHits(message.author.id, imageHash);
    if (hits.length > 0) {
      const channelCount = new Set(hits.map((hit) => hit.channelId)).size;
      return {
        summary: "cross-channel image spam",
        reason: `Cross-channel spam: same image posted in ${channelCount} channels within 60s`,
        duplicateHits: hits,
      };
    }
  }

  // Rule 3: OCR keyword match, only when the cheap rules found nothing.
  for (const { buffer } of downloaded) {
    const inspection = await inspectImage(buffer);
    if (inspection.hasScamIndicators) {
      return {
        summary: "OCR keyword match",
        reason: `OCR keyword match: ${inspection.matchedKeywords.join(", ")}`,
        duplicateHits: [],
      };
    }
  }

  return null;
};

const deleteCrossChannelDuplicates = async (
  client: Client,
  hits: CrossChannelHit[],
  triggerMessageId: string,
) => {
  const otherHits = hits.filter((hit) => hit.messageId !== triggerMessageId);

  await Promise.all(
    otherHits.map(async (hit) => {
      const channel = await getTextChannel(client, hit.channelId);
      if (!channel) {
        return;
      }

      const duplicateMessage = await channel.messages
        .fetch(hit.messageId)
        .catch(() => null);

      if (duplicateMessage?.deletable) {
        await duplicateMessage.delete().catch(() => null);
      }
    }),
  );
};

export const registerScamReviewHandlers = (client: Client) => {
  const pendingReviewsByMessage = new Map<string, PendingReview>();
  const pendingReviewByUser = new Map<string, PendingReview>();
  const userQueues = new Map<string, Promise<void>>();

  // Load the OCR worker now so the first inspection doesn't pay the
  // multi-second worker boot cost.
  void warmUpImageInspector();

  const clearPendingReview = (review: PendingReview) => {
    pendingReviewsByMessage.delete(review.logMessageId);
    pendingReviewByUser.delete(review.userId);
  };

  // A flagged user's later posts are deleted without a new review or ping;
  // the existing review message just gets its counter bumped.
  const suppressAdditionalPost = async (
    message: Message<true>,
    review: PendingReview,
  ) => {
    if (message.deletable) {
      await message.delete().catch(() => null);
    }

    review.suppressedCount += 1;

    const logChannel = await getTextChannel(client, LOG_CHANNEL_ID);
    if (!logChannel) {
      return;
    }

    const logMessage = await logChannel.messages
      .fetch(review.logMessageId)
      .catch(() => null);

    if (!logMessage || logMessage.embeds.length === 0) {
      return;
    }

    const embedData = logMessage.embeds[0].toJSON();
    const fields = embedData.fields ?? [];
    const suppressedField = fields.find(
      (field) => field.name === SUPPRESSED_FIELD_NAME,
    );

    if (suppressedField) {
      suppressedField.value = `${review.suppressedCount}`;
    } else {
      fields.push({
        name: SUPPRESSED_FIELD_NAME,
        value: `${review.suppressedCount}`,
      });
    }

    await logMessage
      .edit({ embeds: [EmbedBuilder.from(embedData).setFields(fields)] })
      .catch(() => null);
  };

  const handleImageMessage = async (
    message: Message<true>,
    imageAttachments: Attachment[],
  ) => {
    const existingReview = pendingReviewByUser.get(message.author.id);
    if (existingReview) {
      await suppressAdditionalPost(message, existingReview);
      return;
    }

    const downloaded = await downloadAttachments(imageAttachments);
    if (downloaded.length === 0) {
      return;
    }

    const detection = await detectSpam(message, downloaded);
    if (!detection) {
      return;
    }

    // Act on the user immediately; the review message can follow.
    const member = await message.guild.members
      .fetch(message.author.id)
      .catch(() => null);

    await Promise.all([
      member
        ?.timeout(
          DEFAULT_TIMEOUT_MS,
          `Auto-timeout pending scam review (${detection.summary})`,
        )
        .catch(() => null),
      message.deletable ? message.delete().catch(() => null) : null,
    ]);

    const cleanupPromise =
      detection.duplicateHits.length > 0
        ? deleteCrossChannelDuplicates(
            client,
            detection.duplicateHits,
            message.id,
          )
        : Promise.resolve();

    const logChannel = await getTextChannel(client, LOG_CHANNEL_ID);
    if (!logChannel) {
      await cleanupPromise;
      return;
    }

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
          value: truncate(detection.reason),
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
        value: "User has been timed out immediately pending moderator review.",
      })
      .setFooter({ text: "React below to take action" })
      .setTimestamp();

    // Attach the already-downloaded buffers: the original message is gone,
    // so its CDN URLs can't be relied on.
    const logMessage = await logChannel.send({
      content: `🚨 <@&${MOD_ROLE_ID}> - Review needed`,
      embeds: [embed],
      files: downloaded.map(
        ({ attachment, buffer }) =>
          new AttachmentBuilder(buffer, {
            name: attachment.name ?? "image.png",
          }),
      ),
    });

    const review: PendingReview = {
      logMessageId: logMessage.id,
      userId: message.author.id,
      userTag: message.author.tag,
      guildId: message.guildId,
      originalChannelId: message.channelId,
      suppressedCount: 0,
    };

    pendingReviewsByMessage.set(logMessage.id, review);
    pendingReviewByUser.set(message.author.id, review);

    await logMessage.react("✅");
    await logMessage.react("🔨");
    await logMessage.react("⏰");
    await logMessage.react("👁️");

    await notifyUserOfRemoval(client, message.author.id);
    await cleanupPromise;
  };

  client.on("messageCreate", (message: Message) => {
    if (message.author.bot || !message.inGuild()) {
      return;
    }

    const imageAttachments = [...message.attachments.values()].filter(
      isImageAttachment,
    );

    if (imageAttachments.length === 0) {
      return;
    }

    // Serialize processing per user so a burst of posts can't race past the
    // pending-review check and each create its own review + mod ping.
    const userId = message.author.id;
    const previous = userQueues.get(userId) ?? Promise.resolve();
    const task = previous
      .then(() => handleImageMessage(message, imageAttachments))
      .catch((error) => console.error("Scam handler error:", error));

    userQueues.set(userId, task);
    void task.finally(() => {
      if (userQueues.get(userId) === task) {
        userQueues.delete(userId);
      }
    });
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
