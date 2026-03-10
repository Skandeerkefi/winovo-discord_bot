require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");

const axios = require("axios");

// ================= CLIENT =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ================= COMMANDS =================
const commands = [
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show Winovo creator leaderboard"),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

// ================= READY EVENT =================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log("✅ Slash commands registered");
  } catch (err) {
    console.error("Command registration error:", err);
  }
});

// ================= HELPER FUNCTION =================
async function fetchLeaderboard(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get("https://winovo.io/api/creator/users", {
        headers: { "x-creator-auth": process.env.CREATOR_API_KEY },
      });

      if (res.data.status === "ok" && Array.isArray(res.data.data)) {
        return res.data.data;
      }

      console.warn("Winovo API temporary issue:", res.data);
      await new Promise((r) => setTimeout(r, 2000));

    } catch (err) {
      console.error("API call error:", err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return null; // failed after retries
}

// ================= COMMAND HANDLER =================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "leaderboard") {
    await interaction.deferReply();

    const users = await fetchLeaderboard();

    if (!users) {
      return interaction.editReply(
        "⚠️ Winovo leaderboard is temporarily unavailable. Try again in a few minutes."
      );
    }

    // ================= LEADERBOARD FORMATTING =================
    const medals = ["🥇", "🥈", "🥉"];
    const prizes = ["$350", "$225", "$100", "$50", "$25", "$25", "$25"];

    let rows = users.slice(0, 10).map((u, i) => {
      const medal = medals[i] || `${i + 1}.`;
      const name = (u.name || "Unknown").padEnd(12, " ");
      const wager = `$${Number(u.wagered || 0).toLocaleString()}`.padEnd(12, " ");
      const prize = prizes[i] || "-";

      return `${medal} ${name} ${wager} ${prize}`;
    });

    const description =
      "```" +
      "#  Player       Wagered     Prize\n" +
      rows.join("\n") +
      "```";

    // ================= EMBED =================
    const embed = new EmbedBuilder()
      .setTitle("🏆 Winovo MisterTee Leaderboard")
      .setDescription(description)
      .setColor(0xff0000)
      .setFooter({ text: "Updated live from Winovo API" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
});

// ================= LOGIN =================
client.login(process.env.DISCORD_TOKEN);