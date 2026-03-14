require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");

const axios = require("axios");

const LEADERBOARD_START_ISO = process.env.LEADERBOARD_START_ISO || "2026-03-20T00:00:00";
const BIWEEKLY_INTERVAL_MS = 15 * 24 * 60 * 60 * 1000;
const RESET_CHECK_INTERVAL_MS = 60 * 1000;
const RESET_STATE_PATH = path.join(__dirname, ".leaderboard-reset-state.json");
const leaderboardAnchor = new Date(LEADERBOARD_START_ISO);
let lastCompletedResetAt = null;

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

function formatPeriodDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function getCurrentLeaderboardWindow(now = new Date()) {
  if (Number.isNaN(leaderboardAnchor.getTime())) {
    throw new Error("Invalid LEADERBOARD_START_ISO value");
  }

  if (now < leaderboardAnchor) {
    const endsAt = new Date(leaderboardAnchor.getTime() + BIWEEKLY_INTERVAL_MS);
    return {
      startsAt: leaderboardAnchor,
      endsAt,
      displayEndsAt: new Date(endsAt.getTime() - 1),
      hasStarted: false,
    };
  }

  const elapsed = now.getTime() - leaderboardAnchor.getTime();
  const periodsElapsed = Math.floor(elapsed / BIWEEKLY_INTERVAL_MS);
  const startsAt = new Date(
    leaderboardAnchor.getTime() + periodsElapsed * BIWEEKLY_INTERVAL_MS
  );
  const endsAt = new Date(startsAt.getTime() + BIWEEKLY_INTERVAL_MS);

  return {
    startsAt,
    endsAt,
    displayEndsAt: new Date(endsAt.getTime() - 1),
    hasStarted: true,
  };
}

function loadResetState() {
  try {
    if (!fs.existsSync(RESET_STATE_PATH)) {
      return;
    }

    const raw = fs.readFileSync(RESET_STATE_PATH, "utf8");
    const state = JSON.parse(raw);

    if (typeof state.lastCompletedResetAt === "string") {
      lastCompletedResetAt = state.lastCompletedResetAt;
    }
  } catch (err) {
    console.error("Failed to load leaderboard reset state:", err.message);
  }
}

function saveResetState() {
  try {
    fs.writeFileSync(
      RESET_STATE_PATH,
      JSON.stringify({ lastCompletedResetAt }, null, 2),
      "utf8"
    );
  } catch (err) {
    console.error("Failed to save leaderboard reset state:", err.message);
  }
}

async function clearLeaderboard() {
  const res = await axios.post(
    "https://winovo.io/api/creator/clear",
    {},
    {
      headers: { "x-creator-auth": process.env.CREATOR_API_KEY },
    }
  );

  return res.data;
}

async function runScheduledReset(referenceTime = new Date()) {
  const window = getCurrentLeaderboardWindow(referenceTime);

  if (!window.hasStarted) {
    return;
  }

  if (referenceTime < window.endsAt) {
    return;
  }

  const resetKey = window.startsAt.toISOString();

  if (lastCompletedResetAt === resetKey) {
    return;
  }

  try {
    const result = await clearLeaderboard();

    if (result.status !== "ok" || result.reset !== true) {
      console.warn("Leaderboard clear returned unexpected response:", result);
      return;
    }

    lastCompletedResetAt = resetKey;
    saveResetState();
    console.log(
      `✅ Leaderboard cleared for biweekly period starting ${window.startsAt.toISOString()}`
    );
  } catch (err) {
    console.error("Scheduled leaderboard clear failed:", err.message);
  }
}

function startResetScheduler() {
  if (Number.isNaN(leaderboardAnchor.getTime())) {
    console.error("Invalid LEADERBOARD_START_ISO. Scheduler not started.");
    return;
  }

  loadResetState();
  runScheduledReset();
  setInterval(() => {
    runScheduledReset();
  }, RESET_CHECK_INTERVAL_MS);
}

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

  startResetScheduler();
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
    const leaderboardWindow = getCurrentLeaderboardWindow();

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
      .setFooter({
        text: leaderboardWindow.hasStarted
          ? `Biweekly window: ${formatPeriodDate(leaderboardWindow.startsAt)} to ${formatPeriodDate(leaderboardWindow.displayEndsAt)} | Resets Sat 12:00 AM`
          : `Biweekly leaderboard starts ${formatPeriodDate(leaderboardWindow.startsAt)}`,
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
});

// ================= LOGIN =================
client.login(process.env.DISCORD_TOKEN);