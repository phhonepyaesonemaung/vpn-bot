const mongoose = require("../db");

const schema = new mongoose.Schema({
  telegramId: String,
  region: String,
  plan: String,
  key: String,
  keyId: String,
  server: String,
  dataLimitGb: Number,
  expireAt: Date,
  active: Boolean,
  isTrial: { type: Boolean, default: false },
  trialStartedAt: Date,
  reminderSentAt: Date
});

module.exports = mongoose.model("User", schema);
